// Brief-quality policy for tool briefs. Drives whether the lifecycle
// emits quality warnings on the brief.
//
// Closed enum values: 'strict' | 'warn' | 'off'. The union allows
// `undefined` because callers may construct DraftTask directly without
// going through a schema that defaults the field.
export type BriefQualityPolicy = 'strict' | 'warn' | 'off' | undefined;

export type BriefQualityWarning =
  | 'outsourced_discovery'
  | 'brittle_line_anchors'
  | 'mixed_environment_actions'
  | 'bare_topic_noun'
  | 'no_done_condition'
  | 'no_output_contract'
  | 'tiny_brief'
  | 'huge_brief';
