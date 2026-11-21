// Sidebar animation helpers, all JS-driven (web has no native driver, and mixing them throws).
import { useEffect, useRef } from "react";
import { Animated, Easing, Platform } from "react-native";

export const EASE_OUT = Easing.out(Easing.cubic);

export function tween(value: Animated.Value, toValue: number, duration: number, easing = EASE_OUT) {
  return Animated.timing(value, { toValue, duration, easing, useNativeDriver: false });
}

/** Goes from 0 to 1 on mount, for fade-in, slide-up and pop-in. */
export function useMountAnim(duration = 200, delay = 0): Animated.Value {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.sequence([Animated.delay(delay), tween(v, 1, duration)]);
    a.start();
    return () => a.stop();
  }, [v, duration, delay]);
  return v;
}

/** Transitions between 0 and 1 following a boolean (e.g. the collapse chevron). */
export function useToggleAnim(on: boolean, duration = 180): Animated.Value {
  const v = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    const a = tween(v, on ? 1 : 0, duration);
    a.start();
    return () => a.stop();
  }, [v, on, duration]);
  return v;
}

/** CSS transitions on web (hover background, text color); ignored on native. */
export const webTransition: object =
  Platform.OS === "web"
    ? { transitionProperty: "background-color, color, opacity", transitionDuration: "140ms", transitionTimingFunction: "ease-out" }
    : {};
