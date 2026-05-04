export interface IntakeStage<I, O> {
  name: string;
  run(input: I): O;
}

export class IntakePipeline<TIn, TOut> {
  constructor(private stages: IntakeStage<any, any>[]) {}

  run(input: TIn): TOut {
    let value: any = input;
    for (const stage of this.stages) value = stage.run(value);
    return value;
  }
}
