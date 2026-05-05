// Back-compat alias: spec C7 has a single unified EventEmitter that fans out
// to channels/sinks. EventEmitter is kept as a re-export so call sites can migrate
// over without churn — new code should import EventEmitter directly.
export { EventEmitter as EventEmitter, type EventSink } from './event-emitter.js';
