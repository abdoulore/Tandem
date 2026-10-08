import { ASSETS } from "../shared/assets";
import { multiplierEvent, pausedEvent, staticEvents, type LifecycleEvent } from "../shared/lifecycle";
import type { TokenState } from "./tokenState";

/** Every lifecycle event Tandem knows now: conversion deadlines, pending multiplier changes, issuer pauses. */
export function lifecycleEvents(tokens: TokenState, nowSec = Date.now() / 1000): LifecycleEvent[] {
  const out = staticEvents();
  for (const a of ASSETS) {
    const s = tokens.get(a.ticker);
    if (!s) continue;
    if (s.effectiveAt > nowSec && s.newMultiplier !== s.multiplier) out.push(multiplierEvent(a.ticker, s.multiplier, s.newMultiplier, s.effectiveAt));
    if (s.paused) out.push(pausedEvent(a.ticker));
  }
  return out;
}
