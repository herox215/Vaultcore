package com.vaultcore.app

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  // mDNS multicast lock — Android drops multicast UDP packets by default
  // unless an app holds a WifiManager.MulticastLock. We acquire it once
  // in onCreate and release in onDestroy so the Rust-side mdns-sd
  // advertiser/browser can see peers on the local network.
  // Held across the activity lifecycle; the cost is a small battery hit
  // when the app is foregrounded — acceptable for v1 LAN-sync UAT.
  private var multicastLock: WifiManager.MulticastLock? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    acquireMulticastLock()
  }

  override fun onDestroy() {
    releaseMulticastLock()
    super.onDestroy()
  }

  private fun acquireMulticastLock() {
    if (multicastLock != null) return
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      ?: return
    val lock = wifi.createMulticastLock("vaultcore-mdns")
    lock.setReferenceCounted(false)
    lock.acquire()
    multicastLock = lock
  }

  private fun releaseMulticastLock() {
    multicastLock?.let { if (it.isHeld) it.release() }
    multicastLock = null
  }
}
