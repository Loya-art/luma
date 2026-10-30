import { cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';

export type MotionPhase = 'enter' | 'idle' | 'exit';
const DURATION = 280;

/** Keep a departing surface long enough to finish its exit, without delaying its state change. */
export function usePresence<T>(value: T | null | undefined | false) {
  const present = value !== null && value !== undefined && value !== false;
  const retained = useRef<T | null>(present ? value as T : null);
  if (present) retained.current = value as T;
  const [mounted, setMounted] = useState(present);
  const [phase, setPhase] = useState<MotionPhase>('enter');
  useLayoutEffect(() => {
    if (present) { setMounted(true); setPhase('enter'); }
    else setPhase('exit');
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : DURATION;
    const timer = window.setTimeout(() => {
      if (present) setPhase('idle');
      else { setMounted(false); retained.current = null; }
    }, duration);
    return () => window.clearTimeout(timer);
  }, [present]);
  return { value: present ? value as T : mounted ? retained.current : null, phase, present };
}

type SurfaceProps = HTMLAttributes<HTMLElement> & { 'data-motion'?: MotionPhase };
/** The child is a DOM surface, so it keeps its own positioning and glass backdrop. */
export function Presence({ children }: { children: ReactNode }) {
  const child = isValidElement(children) ? children as ReactElement<SurfaceProps> : null;
  const wasPresent = useRef(Boolean(child));
  const returnFocus = useRef<HTMLElement | null>(null);
  if (child && !wasPresent.current && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
  wasPresent.current = Boolean(child);
  const { value, phase, present } = usePresence(child);
  useEffect(() => {
    if (!present && value && document.activeElement instanceof HTMLElement && (document.activeElement.closest('[data-motion="exit"],[aria-hidden="true"]') || document.activeElement === document.body)) {
      document.activeElement.blur();
      if (returnFocus.current?.isConnected && !returnFocus.current.closest('[aria-hidden="true"],[inert]')) returnFocus.current.focus({ preventScroll: true });
    }
  }, [present]);
  if (!value) return null;
  const block: React.PointerEventHandler<HTMLElement> = event => { event.preventDefault(); event.stopPropagation(); };
  return cloneElement(value, {
    'data-motion': phase,
    'aria-hidden': !present || value.props['aria-hidden'],
    onPointerDownCapture: present ? value.props.onPointerDownCapture : block,
    onClickCapture: present ? value.props.onClickCapture : event => { event.preventDefault(); event.stopPropagation(); },
    onKeyDownCapture: present ? value.props.onKeyDownCapture : event => { event.preventDefault(); event.stopPropagation(); },
    onFocusCapture: present ? value.props.onFocusCapture : event => event.target instanceof HTMLElement && event.target.blur(),
  });
}
