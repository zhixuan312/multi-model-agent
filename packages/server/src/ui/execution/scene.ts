/**
 * The execution monitor's stage: a three-act scene built as one SVG string.
 *
 * Coordinate system is fixed at `0 0 52 30` for every act, because the camera never moves —
 * the frame stays put and the scene resolves inside it. Two horizontal lines are load-bearing
 * and everything is measured against them:
 *
 *   floor  y = 27.6   feet rest here; nothing may cross it
 *   bench  y = 23     work surface; no tool, subject or prop may pass through it
 *
 * Colours come from `--mma-*` custom properties defined in `execution.html`, applied through
 * classes rather than inline fills so the palette lives in exactly one place and the host
 * fallback discipline is enforced by the stylesheet's own test.
 *
 * ANATOMY RULE: a figure's legs sit OUTSIDE its `lean` group, so `lean` may only ever be
 * ROTATED at the hip. Translating it lifts the torso off the legs. For the same reason arm
 * motion is two nested rotations — shoulder then elbow — never a translation of the limb.
 */

import { artFor, type ToolId } from './type-art.js';

export type Act = 'work' | 'review' | 'end';
export type Ending = 'done' | 'concerns' | 'failed' | 'cancelled';

const FLOOR = `<rect x="0" y="27.6" width="52" height=".8" class="s-edge"/>`;
const BENCH =
  `<rect x="9" y="23" width="25" height="1.7" rx=".4" class="s-mat"/>`
  + `<rect x="12.5" y="24.7" width="1.6" height="2.9" class="s-edge"/>`
  + `<rect x="29" y="24.7" width="1.6" height="2.9" class="s-edge"/>`;

interface FigureOpts {
  dx?: number;
  faded?: boolean;
  /** Shoulder angle, degrees. Omitted where CSS drives the pose. */
  ua?: number;
  /** Elbow angle, degrees, relative to the upper arm. */
  fa?: number;
  tool?: string;
}

/** The worker (implementer). Faces left; arm extends left, so a POSITIVE rotation lifts it. */
function worker(o: FigureOpts = {}): string {
  const pose = (v: number | undefined) => (v == null ? '' : ` style="transform:rotate(${v}deg)"`);
  return `<g transform="translate(${o.dx ?? 0} 0)"${o.faded ? ' opacity=".45"' : ''}>`
    + `<rect x="38.3" y="22.4" width="1.9" height="5.2" class="s-fig"/>`
    + `<rect x="41.1" y="22.4" width="1.9" height="5.2" class="s-fig"/>`
    + `<g class="lean">`
    + `<rect x="38" y="15.8" width="5.2" height="6.6" class="s-fig"/>`
    + `<rect x="38" y="11.2" width="5.2" height="4.6" rx="1.2" class="s-fig"/>`
    + `<g class="ua"${pose(o.ua)}>`
    + `<rect x="34.2" y="16.65" width="4.4" height="1.5" rx=".75" class="s-fig"/>`
    + `<g class="fa"${pose(o.fa)}>`
    + `<rect x="30.6" y="16.65" width="3.8" height="1.5" rx=".75" class="s-fig"/>`
    + `<circle cx="30.7" cy="17.4" r="1.25" class="s-fig"/>${o.tool ?? ''}`
    + `</g></g></g></g>`;
}

/** The reviewer. Faces right; arm extends right, so a NEGATIVE rotation lifts it. */
function inspector(o: FigureOpts = {}): string {
  const pose = (v: number | undefined) => (v == null ? '' : ` style="transform:rotate(${v}deg)"`);
  return `<g transform="translate(${o.dx ?? 0} 0)"${o.faded ? ' opacity=".3"' : ''}>`
    + `<rect x="2.7" y="22.4" width="1.8" height="5.2" class="s-fig"/>`
    + `<rect x="5.3" y="22.4" width="1.8" height="5.2" class="s-fig"/>`
    + `<g class="ilean">`
    + `<rect x="2.4" y="15.8" width="5" height="6.6" class="s-fig"/>`
    + `<rect x="2.4" y="11.2" width="5" height="4.6" rx="1.2" class="s-fig"/>`
    + `<g class="iua"${pose(o.ua)}>`
    + `<rect x="6.8" y="16.65" width="4.2" height="1.5" rx=".75" class="s-fig"/>`
    + `<g class="ifa"${pose(o.fa)}>`
    + `<rect x="10.8" y="16.65" width="3.8" height="1.5" rx=".75" class="s-fig"/>`
    + `<circle cx="14.4" cy="17.4" r="1.25" class="s-fig"/>${o.tool ?? ''}`
    + `</g></g></g></g>`;
}

/** The reviewer always carries a lens: reviewing is the same operation for every type. */
const REVIEWER_LENS =
  `<line x1="15" y1="17.5" x2="16.8" y2="17.9" class="s-fig-s" stroke-width="1.4" stroke-linecap="round"/>`
  + `<circle cx="19.6" cy="18.4" r="2.8" class="s-cool-f" fill-opacity=".12"/>`
  + `<circle cx="19.6" cy="18.4" r="2.8" fill="none" class="s-cool-s" stroke-width="1"/>`
  + `<path d="M17.9 17 A2.2 2.2 0 0 1 19.3 16.2" fill="none" class="s-cool-s" stroke-width=".65" stroke-linecap="round" opacity=".8"/>`;

/** Tools, drawn in the forearm's frame and scaled against the figure's 4.6-unit head. */
const TOOLS: Record<ToolId, string> = {
  lens:
    `<line x1="30.2" y1="17.5" x2="26.9" y2="18.1" class="s-fig-s" stroke-width="1.5" stroke-linecap="round"/>`
    + `<circle cx="23.9" cy="18.4" r="2.9" class="s-acc-f" fill-opacity=".12"/>`
    + `<circle cx="23.9" cy="18.4" r="2.9" fill="none" class="s-acc-s" stroke-width="1.05"/>`
    + `<path d="M22.1 17 A2.3 2.3 0 0 1 23.6 16.2" fill="none" class="s-acc-s" stroke-width=".7" stroke-linecap="round" opacity=".8"/>`,
  hammer:
    `<rect x="23.6" y="16.75" width="7.4" height="1.3" rx=".65" class="s-mat"/>`
    + `<path d="M23.9 14.9 h3.1 l1.1 1 v3 l-1.1 1 h-3.1 Z" class="s-fig"/>`
    + `<path d="M27 15.9 h1.1 v3 h-1.1 Z" class="s-edge"/>`,
  quill:
    `<g transform="rotate(-46 25.6 18.9)">`
    + `<path d="M25.6 18.9 l1.9 -.8 l-.4 1.7 Z" class="s-fig"/>`
    + `<path d="M27.1 18.4 l3 -.3" class="s-fig-s" stroke-width=".8" stroke-linecap="round"/>`
    + `<path d="M29.6 18.5 C 33 15.4, 37 15.5, 39.6 17.4 C 37 20 32.6 20.6 29.6 18.5 Z" class="s-acc-f" fill-opacity=".2"/>`
    + `<path d="M29.6 18.5 C 33 15.4, 37 15.5, 39.6 17.4 C 37 20 32.6 20.6 29.6 18.5 Z" fill="none" class="s-acc-s" stroke-width=".65"/>`
    + `<path d="M30 18.3 L39.3 17.5" class="s-acc-s" stroke-width=".6" stroke-linecap="round"/>`
    + `</g>`,
  compass:
    `<circle cx="29.2" cy="14.2" r="1.35" class="s-fig"/>`
    + `<rect x="28.4" y="11.5" width="1.6" height="2.4" rx=".8" class="s-mat"/>`
    + `<path d="M29.2 14.2 L24.6 21.4" class="s-fig-s" stroke-width="1.1" stroke-linecap="round"/>`
    + `<path d="M24.8 20.7 L24.1 22.5" class="s-fig-s" stroke-width=".7" stroke-linecap="round"/>`
    + `<path d="M29.2 14.2 L31.4 21.4" class="s-fig-s" stroke-width="1.1" stroke-linecap="round"/>`
    + `<path d="M31 20.2 L31.8 22.4" class="s-acc-s" stroke-width="1.4" stroke-linecap="round"/>`,
  rod:
    `<rect x="25.9" y="16.65" width="5.2" height="1.5" rx=".7" class="s-fig"/>`
    + `<path d="M25.9 16.9 L21.6 17.3 L20.3 17.5 L21.6 17.7 L25.9 17.9 Z" class="s-mat"/>`
    + `<path d="M20.3 17.5 L18.4 17.7" class="s-acc-s" stroke-width=".85" stroke-linecap="round"/>`,
  sheaf:
    `<g transform="rotate(-8 27 18)"><rect x="23.4" y="14.6" width="6.4" height="7.4" rx=".7" class="s-paper s-line-s" stroke-width=".8"/></g>`
    + `<g transform="rotate(4 27 18)"><rect x="24.6" y="15.4" width="6.4" height="7.4" rx=".7" class="s-paper s-acc-s" stroke-width=".8"/></g>`,
  lever:
    `<rect x="24.6" y="20.6" width="6.4" height="1.5" rx=".75" class="s-edge"/>`
    + `<path d="M27.8 21 L27.8 16.6" class="s-fig-s" stroke-width="1.2" stroke-linecap="round"/>`
    + `<circle cx="27.8" cy="15.6" r="1.6" class="s-acc-f"/>`,
};

/**
 * Resting angles for the reviewing act, per tool.
 *
 * A single lowering angle does not work: the compass, the paper stack and the lever all hang
 * low in the hand, and an angle that is safe for a lens drives those through the bench.
 */
const REST_POSE: Record<ToolId, [number, number]> = {
  lens: [-6, -2], hammer: [-10, -4], quill: [-6, -2],
  compass: [2, 0], rod: [-6, -2], sheaf: [0, 0], lever: [0, 0],
};

/** The tool set down on the bench, for the endings. */
const TOOL_AT_REST: Record<ToolId, string> = {
  hammer: `<rect x="19" y="21.4" width="7" height="1.2" rx=".6" class="s-mat"/><path d="M25.6 20 h2.6 l.9 .9 v2.1 h-3.5 Z" class="s-fig"/>`,
  lens: `<circle cx="23" cy="21.4" r="1.9" fill="none" class="s-mat-s" stroke-width=".9"/><line x1="24.4" y1="22.6" x2="27" y2="22.9" class="s-fig-s" stroke-width="1.1" stroke-linecap="round"/>`,
  quill: `<path d="M20 22.6 C 23 20.6, 27 20.8, 29 22.4 C 26.4 23.4 22.4 23.6 20 22.6 Z" class="s-mat-f" fill-opacity=".35"/>`,
  compass: `<path d="M22 22.8 L24.4 19.6 L26.8 22.8" fill="none" class="s-fig-s" stroke-width="1"/>`,
  rod: `<rect x="21" y="21.8" width="6" height="1.1" rx=".5" class="s-fig"/>`,
  sheaf: `<rect x="21" y="20.4" width="6" height="2.4" rx=".5" class="s-paper s-line-s" stroke-width=".7"/>`,
  lever: `<rect x="22" y="21.6" width="5" height="1.2" rx=".6" class="s-edge"/>`,
};

const sheet = () =>
  `<path d="M13 12.6 h9.6 l3.4 3.4 V23 H13 Z" class="s-paper s-line-s" stroke-width=".9"/>`
  + `<path d="M22.6 12.6 v3.4 h3.4" fill="none" class="s-line-s" stroke-width=".9"/>`;

/** Gear centred so its lower teeth clear the bench at y 23. */
function gear(skipTooth: number): string {
  const cy = 15.6;
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    if (i === skipTooth) continue;
    out += `<rect x="18" y="${cy - 7.4}" width="2" height="2.4" rx=".4" class="s-line" transform="rotate(${i * 45} 19 ${cy})"/>`;
  }
  return out
    + `<circle cx="19" cy="${cy}" r="5" class="s-paper s-line-s" stroke-width="1.1"/>`
    + `<circle cx="19" cy="${cy}" r="1.6" class="s-line" opacity=".45"/>`;
}

const rule = (d: string, w = '.6', extra = '') => `<path d="${d}" class="s-line-s" stroke-width="${w}" stroke-linecap="round" opacity=".5"${extra}/>`;

/** Subjects. Every one sits on or above the bench line; none crosses y 23. */
const SUBJECTS: Record<string, () => string> = {
  default: () => sheet() + rule('M14.4 17.4h9.6') + rule('M14.4 19.6h9.6') + rule('M14.4 21.8h6'),
  audit: () => sheet()
    + `<rect x="14.4" y="16.4" width="7" height="1.2" rx=".6" class="s-line" opacity=".7"/>`
    + rule('M14.4 19.2h9.6') + rule('M14.4 20.8h9.6') + rule('M14.4 22.4h6')
    + `<g class="s-acc-s" stroke-width=".7" stroke-linecap="round"><path class="ink" d="M23.2 19.2h1.2"/><path class="ink ink2" d="M23.2 20.8h1.2"/></g>`,
  investigate: () =>
    `<g fill="none" class="s-line-s" stroke-width=".7" opacity=".85"><path d="M12.6 12.2V21.2"/><path d="M12.6 13.8h2.6"/><path d="M12.6 17.4h2.6"/><path d="M12.6 21h2.6"/></g>`
    + `<g class="s-paper s-line-s" stroke-width=".8"><rect x="15.2" y="11.8" width="9.4" height="4" rx=".7"/><rect x="15.2" y="15.4" width="9.4" height="4" rx=".7"/><rect x="15.2" y="19" width="9.4" height="4" rx=".7"/></g>`
    + `<rect class="ink s-acc-f s-acc-s" fill-opacity=".25" x="15.2" y="15.4" width="9.4" height="4" rx=".7" stroke-width="1"/>`
    + `<path class="ink ink2 s-acc-f" d="M27.4 17.4 a1.8 1.8 0 1 0 -3.6 0 c0 1.4 1.8 3.2 1.8 3.2 s1.8 -1.8 1.8 -3.2 Z"/>`,
  delegate: () =>
    `<g class="heat s-acc-s" stroke-width=".7" opacity=".6" stroke-linecap="round"><path d="M18 17.4 c1 -1.2 -1 -2.2 0 -3.4"/><path d="M22 17 c1 -1.2 -1 -2.2 0 -3.4"/><path d="M26 17.4 c1 -1.2 -1 -2.2 0 -3.4"/></g>`
    + `<path d="M15 20 h13 l-1.6 3 H16.6 Z" class="s-acc-f"/><path d="M15 20 h13 l-.9 -1.9 H15.9 Z" class="s-acc-f" opacity=".65"/>`,
  execute_plan: () =>
    `<rect x="10.6" y="6.4" width="17" height="11" rx=".9" class="s-paper s-line-s" stroke-width=".8"/>`
    + `<g fill="none" class="s-acc-s" stroke-width=".9" stroke-linecap="round" stroke-linejoin="round">`
    + `<path class="tick" d="M12.2 9 l1.1 1.1 l2 -2.3"/><path class="tick tick2" d="M12.2 12.2 l1.1 1.1 l2 -2.3"/>`
    + `<path class="tick tick3" d="M12.2 15.4 l1.1 1.1 l2 -2.3"/></g>`
    + rule('M17 9.2h8.6', '.55') + rule('M17 12.4h8.6', '.55') + rule('M17 15.6h6', '.55')
    + `<path d="M15.6 20 h12 l-1.5 3 H17.1 Z" class="s-acc-f"/>`,
  review: () => sheet()
    + `<rect x="14.2" y="15.6" width="1.4" height="7.4" class="s-line" opacity=".2"/>`
    + `<g stroke-linecap="round"><path class="ink s-acc-s" d="M14.9 17h.05" stroke-width="1.6"/>`
    + `<path class="ink ink2 s-bad-s" d="M14.9 19.4h.05" stroke-width="1.6"/>`
    + `<path class="ink ink3 s-acc-s" d="M14.9 21.8h.05" stroke-width="1.6"/></g>`
    + rule('M16.6 17h7.4') + rule('M17.9 19.4h6.1') + rule('M17.9 21.8h4'),
  debug: () => gear(1)
    + `<circle cx="23" cy="10.8" r="2.6" fill="none" class="s-acc-s" stroke-width=".8" stroke-dasharray="1.4 1.3"/>`
    + `<g class="spk s-acc-s" stroke-width="1.1" stroke-linecap="round"><path d="M23.2 10.6 l2.4 -2.3"/><path d="M24 12.2 l3 -.4"/><path d="M21.8 9.4 l.5 -2.6"/></g>`,
  research: () =>
    `<path d="M6.6 10 V23.5" class="s-line-s" stroke-width=".8" stroke-dasharray="1.6 1.6" opacity=".85"/>`
    + `<g class="arr"><rect x="9.6" y="16.4" width="5.4" height="6.6" rx=".7" class="s-paper s-line-s" stroke-width=".8"/></g>`
    + `<g class="arr arr2"><rect x="16.4" y="14.6" width="5.4" height="8.4" rx=".7" class="s-paper s-acc-s" stroke-width=".8"/></g>`,
  journal_recall: () =>
    `<rect x="11" y="18.4" width="15" height="4.6" rx=".8" class="s-paper s-line-s" stroke-width=".9"/>`
    + `<rect x="16.4" y="20.2" width="4.2" height="1.1" rx=".55" class="s-line" opacity=".6"/>`
    + `<g class="s-paper s-line-s" stroke-width=".8"><rect x="11.8" y="13.6" width="5" height="5.2" rx=".6" transform="rotate(-10 14.3 16.2)"/>`
    + `<rect x="21" y="13.6" width="5" height="5.2" rx=".6" transform="rotate(10 23.5 16.2)"/></g>`
    + `<rect class="ink s-acc-f s-acc-s" fill-opacity=".22" x="16" y="11.4" width="5" height="7.4" rx=".6" stroke-width=".9"/>`,
  journal_record: () =>
    `<path d="M10 14.6 C13.4 13.2 16.2 13.2 18.4 14.6 V23 C16.2 21.8 13.4 21.8 10 23 Z" class="s-paper s-line-s" stroke-width=".9"/>`
    + `<path d="M18.4 14.6 C20.6 13.2 23.4 13.2 26.8 14.6 V23 C23.4 21.8 20.6 21.8 18.4 23 Z" class="s-paper s-line-s" stroke-width=".9"/>`
    + `<path d="M18.4 14.6 V23" class="s-line-s" stroke-width=".9"/>`
    + `<g class="s-acc-s" stroke-width=".6" opacity=".9" stroke-linecap="round"><path class="ink" d="M11.6 17h5"/><path class="ink ink2" d="M11.6 19.2h5"/><path class="ink ink3" d="M20.4 17h5"/></g>`,
  orchestrate: () =>
    `<rect x="11.6" y="12.4" width="17" height="10.6" rx="1" class="s-paper s-line-s" stroke-width=".9"/>`
    + `<circle cx="21" cy="18" r="4" fill="none" class="s-line-s" stroke-width=".8"/>`
    + `<g class="ndl"><path d="M21 18 L21 14.6" class="s-acc-s" stroke-width="1.1" stroke-linecap="round"/></g>`
    + `<circle cx="21" cy="18" r=".8" class="s-acc-f"/>`
    + `<rect x="25.4" y="17.4" width="1.8" height="4" rx=".9" class="s-acc-f"/>`
    + `<circle class="ink s-acc-f" cx="14" cy="14.6" r=".9"/><circle class="ink ink2 s-acc-f" cx="16.2" cy="14.6" r=".9"/>`,
  spec: () => sheet()
    + `<rect x="14.4" y="15.8" width="6.6" height="1.1" rx=".55" class="s-acc-f" opacity=".55"/>`
    + `<g class="s-acc-s" stroke-width=".65" opacity=".9" stroke-linecap="round"><path class="ink" d="M14.4 18.6h9.6"/><path class="ink ink2" d="M14.4 20.4h9.6"/><path class="ink ink3" d="M14.4 22.2h5.4"/></g>`
    + `<circle cx="24" cy="21" r="1.9" class="s-acc-f s-acc-s" fill-opacity=".3" stroke-width=".8"/>`,
  plan: () =>
    `<rect x="11" y="11.6" width="15" height="11.4" rx=".8" class="s-paper s-acc-s" stroke-width=".9"/>`
    + `<g class="s-acc-s" stroke-width=".3" opacity=".32"><path d="M14.8 11.6v11.4"/><path d="M18.5 11.6v11.4"/><path d="M22.2 11.6v11.4"/><path d="M11 15.4h15"/><path d="M11 19.2h15"/></g>`
    + `<g class="s-acc-f s-acc-s" fill-opacity=".25" stroke-width=".75"><rect class="ink" x="12.2" y="12.6" width="5" height="2.2"/>`
    + `<rect class="ink ink2" x="15.4" y="16.4" width="6" height="2.2"/><rect class="ink ink3" x="18.6" y="20.2" width="5.4" height="2.2"/></g>`,
};

/**
 * Measured extents per subject, used to normalise the raise.
 *
 * A single raise transform cannot serve twelve differently-sized subjects: a wide billet
 * overshoots one hand and a narrow stack leaves the other holding air. Each subject is scaled
 * to land 9 units wide at most, 8.6 tall at most, centred on x 26.3 with its underside at
 * y 11.6 — which is exactly where the two raised hands meet.
 */
const EXTENTS: Record<string, [number, number, number, number]> = {
  default: [13, 12.6, 26, 23],
  audit: [13, 12.6, 26, 23],
  investigate: [12.2, 11.8, 27.4, 23],
  delegate: [15, 14, 28, 23],
  execute_plan: [10.6, 6.4, 27.6, 23],
  review: [13, 12.6, 26, 23],
  debug: [11.6, 6.8, 27, 23],
  research: [6.6, 10, 21.8, 23.5],
  journal_recall: [11, 11.4, 26, 23],
  journal_record: [10, 13.2, 26.8, 23],
  orchestrate: [11.6, 12.4, 28.6, 23],
  spec: [13, 12.6, 26, 23],
  plan: [11, 11.6, 26, 23],
};

export function raiseTransform(subject: string): string {
  const [x0, y0, x1, y1] = EXTENTS[subject] ?? EXTENTS.default;
  const scale = Math.min(9 / (x1 - x0), 8.6 / (y1 - y0));
  const tx = 26.3 - scale * (x0 + x1) / 2;
  const ty = 11.6 - scale * y1;
  return `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(3)})`;
}

const CRACK = `<g class="spk s-bad-s" stroke-width="1" stroke-linecap="round"><path d="M17 12.4 l2.6 3.4 l-2 2.6 l3 3.4"/></g>`;
const GLINT = `<g class="glint s-ok-s" stroke-width=".9" stroke-linecap="round">`
  + `<path d="M22.5 2.1 l0 -1.8"/><path d="M30.1 2.1 l0 -1.8"/><path d="M26.3 .9 l0 -.8"/></g>`;
const IMPACT = `<g class="hitk s-acc-s" stroke-width="1.1" stroke-linecap="round">`
  + `<path d="M24.4 20.6 l-2.2 -2.2"/><path d="M23.6 21.8 l-2.8 -.4"/><path d="M26 19.8 l-.7 -2.6"/></g>`;

export interface SceneInput {
  type?: string;
  act: Act;
  ending?: Ending;
}

/** Class on the root `<svg>`; the stylesheet keys every animation and colour off it. */
export function sceneClass(input: SceneInput): string {
  const art = artFor(input.type);
  if (input.act === 'end') return `sc end-${input.ending ?? 'done'}`;
  if (input.act === 'review') return 'sc live act-review';
  return `sc live act-work v-${art.verb} t-${art.tool}`;
}

export function sceneSvg(input: SceneInput): string {
  const art = artFor(input.type);
  const subject = (SUBJECTS[art.subject] ?? SUBJECTS.default)();
  const tool = TOOLS[art.tool];

  if (input.act === 'work') {
    return FLOOR + subject + BENCH + worker({ tool })
      + (art.verb === 'strike' ? IMPACT : '');
  }

  if (input.act === 'review') {
    const [ua, fa] = REST_POSE[art.tool];
    return FLOOR + subject + BENCH
      + worker({ dx: 3, ua, fa, tool })
      + inspector({ tool: REVIEWER_LENS });
  }

  const ending = input.ending ?? 'done';
  if (ending === 'done' || ending === 'concerns') {
    // Both figures stay and raise the piece together: the reviewer refines the worker's
    // output, so a shared lift is a truer picture than one of them presenting to the other.
    return FLOOR + BENCH + TOOL_AT_REST[art.tool]
      + `<g transform="${raiseTransform(art.subject)}"><g class="held">${subject}</g></g>`
      + GLINT
      + inspector({ dx: 9.8 })
      + worker({ dx: -2.2 });
  }
  if (ending === 'failed') {
    // The reviewer never arrives: a failed run has nothing to refine.
    return FLOOR + subject + CRACK + BENCH + worker({ dx: 2.6, ua: -48, fa: -16 });
  }
  return FLOOR + `<g class="dull">${subject}</g>` + BENCH
    + worker({ dx: 6, faded: true, ua: -40, fa: -12 })
    + inspector({ dx: -3, faded: true, ua: 8, fa: 10 });
}
