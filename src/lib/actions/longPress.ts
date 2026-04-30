// Stub — TDD RED phase. Real implementation lands in the GREEN commit.
export interface LongPressDetail {
  clientX: number;
  clientY: number;
  pointerType: string;
  target: EventTarget | null;
}

export interface LongPressOpts {
  duration?: number;
  moveTolerance?: number;
  strict?: boolean;
  onLongPress: (d: LongPressDetail) => void;
}

export function longPress(
  _node: HTMLElement,
  _opts: LongPressOpts,
): { update(o: LongPressOpts): void; destroy(): void } {
  return {
    update() {},
    destroy() {},
  };
}
