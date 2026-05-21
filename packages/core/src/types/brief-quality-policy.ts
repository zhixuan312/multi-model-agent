// Brief-quality policy for tool briefs. Drives whether the lifecycle
// emits quality warnings on the brief.
//
// Closed enum values: 'strict' | 'warn' | 'off'. The union allows
// `undefined` because callers may construct a task directly without
// going through a schema that defaults the field.
export type BriefQualityPolicy = 'strict' | 'warn' | 'off' | undefined;
