// The Mac kit's show engine, shared with the app as plain JS and typed loosely here.
// @ts-ignore plain JS
import { runShow as run } from '../../../tools/train/lib/show/runtime.mjs'
// @ts-ignore plain JS
import { soundsUsed as used } from '../../../tools/train/lib/show/schema.mjs'

export const runShowEngine = run as (show: object, opts: object) => Promise<{ ok: boolean; elapsedMs: number }>
export const soundsUsed = used as (show: object) => string[]
