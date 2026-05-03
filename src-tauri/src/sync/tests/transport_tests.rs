//! TDD coverage for #419 Noise transport layer.

use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::thread;

use crate::sync::protocol::{
    decode_frame, encode_frame, ChangeEvent, ChangeKind, FrameError, SyncFrame, MAX_FRAME_BYTES,
};
use crate::sync::transport::{
    drive_handshake, generate_static_keypair, ik_initiator, ik_responder, xx_initiator,
    xx_responder, EncryptedChannel,
};
use crate::sync::VersionVector;

fn sample_change_event() -> ChangeEvent {
    let mut hash = [0u8; 32];
    hash[0] = 0xAB;
    let mut vv = VersionVector::new();
    vv.increment("PEERA");
    ChangeEvent {
        vault_id: "vault-uuid".into(),
        path: PathBuf::from("notes/a.md"),
        kind: ChangeKind::Upserted {
            content: b"hello world".to_vec(),
        },
        source_peer: "PEERA".into(),
        version_vector: vv,
        content_hash: hash,
    }
}

#[test]
fn change_event_serializes_round_trip() {
    let evt = sample_change_event();
    let frame = SyncFrame::Change(evt.clone());
    let bytes = encode_frame(&frame).unwrap();
    assert!(bytes.len() > 4);
    let (decoded, consumed) = decode_frame(&bytes).unwrap();
    assert_eq!(consumed, bytes.len());
    assert_eq!(decoded, frame);
    if let SyncFrame::Change(e) = decoded {
        assert_eq!(e, evt);
    }

    // Short buffer surfaces as `Short`, not a deserialize error.
    assert_eq!(decode_frame(&bytes[..2]).unwrap_err(), FrameError::Short);
    assert_eq!(decode_frame(&bytes[..3]).unwrap_err(), FrameError::Short);

    // Frame announcing a length over the cap is rejected before alloc.
    let mut malicious = Vec::new();
    malicious.extend_from_slice(&(MAX_FRAME_BYTES + 1).to_be_bytes());
    let err = decode_frame(&malicious).unwrap_err();
    assert!(matches!(err, FrameError::TooLarge { .. }));
}

/// Spec-prescribed: XX bootstrap → IK resume on a fresh connection.
/// Uses two threads on a real loopback TCP pair (no mocks).
#[test]
fn noise_xx_bootstrap_then_ik_resume_with_cached_keys() {
    let initiator_kp = generate_static_keypair().unwrap();
    let responder_kp = generate_static_keypair().unwrap();

    // ─── Round 1: XX bootstrap. Each side learns the other's static key. ───
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let init_priv = initiator_kp.private.clone();
    let resp_priv = responder_kp.private.clone();
    let resp_pub_expected = responder_kp.public.clone();
    let init_pub_expected = initiator_kp.public.clone();

    let resp_thread = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let hs = xx_responder(&resp_priv).unwrap();
        let (transport, remote_static) = drive_handshake(hs, &mut stream, false).unwrap();
        // Responder learned initiator's static key during XX.
        assert_eq!(remote_static.unwrap(), init_pub_expected);
        // Receive a frame, send one back.
        let mut chan = EncryptedChannel { stream, state: transport };
        let frame = chan.recv().unwrap();
        let echo = match frame {
            SyncFrame::Change(_) => SyncFrame::Change(sample_change_event()),
            other => other,
        };
        chan.send(&echo).unwrap();
    });

    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let hs = xx_initiator(&init_priv).unwrap();
    let (transport, remote_static) = drive_handshake(hs, &mut stream, true).unwrap();
    assert_eq!(remote_static.unwrap(), resp_pub_expected);
    let mut chan = EncryptedChannel { stream, state: transport };
    chan.send(&SyncFrame::Change(sample_change_event())).unwrap();
    let echoed = chan.recv().unwrap();
    assert!(matches!(echoed, SyncFrame::Change(_)));
    resp_thread.join().unwrap();

    // ─── Round 2: IK resume. Initiator already knows responder's static. ───
    let listener2 = TcpListener::bind("127.0.0.1:0").unwrap();
    let port2 = listener2.local_addr().unwrap().port();
    let resp_priv2 = responder_kp.private.clone();
    let init_priv2 = initiator_kp.private.clone();
    let resp_pub2 = responder_kp.public.clone();
    let init_pub_expected2 = initiator_kp.public.clone();

    let resp_thread2 = thread::spawn(move || {
        let (mut stream, _) = listener2.accept().unwrap();
        let hs = ik_responder(&resp_priv2).unwrap();
        let (transport, remote_static) = drive_handshake(hs, &mut stream, false).unwrap();
        assert_eq!(remote_static.unwrap(), init_pub_expected2);
        let mut chan = EncryptedChannel { stream, state: transport };
        let _ = chan.recv().unwrap();
        chan.send(&SyncFrame::BatchEnd {
            vault_id: "v".into(),
        })
        .unwrap();
    });
    let mut stream2 = TcpStream::connect(("127.0.0.1", port2)).unwrap();
    let hs = ik_initiator(&init_priv2, &resp_pub2).unwrap();
    let (transport, _remote_static) = drive_handshake(hs, &mut stream2, true).unwrap();
    let mut chan2 = EncryptedChannel { stream: stream2, state: transport };
    chan2
        .send(&SyncFrame::BatchBegin {
            vault_id: "v".into(),
        })
        .unwrap();
    let evt = chan2.recv().unwrap();
    assert_eq!(
        evt,
        SyncFrame::BatchEnd {
            vault_id: "v".into()
        }
    );
    resp_thread2.join().unwrap();
}
