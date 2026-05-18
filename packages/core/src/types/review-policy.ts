// ReviewPolicy — drives the lifecycle reviewing stage's verdict gate.
// 'full' runs spec + quality review; 'quality_only' skips spec review;
// 'diff_only' restricts review to diff scope; 'none' skips review entirely.
export type ReviewPolicy = 'full' | 'quality_only' | 'diff_only' | 'none';
