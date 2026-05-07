export interface BriefSlotFiller<TInput, TBrief> { (input: TInput): TBrief }

export class BriefCompiler<TInput, TBrief> {
  constructor(private slot: BriefSlotFiller<TInput, TBrief>) {}
  compile(input: TInput): TBrief { return this.slot(input); }
}
