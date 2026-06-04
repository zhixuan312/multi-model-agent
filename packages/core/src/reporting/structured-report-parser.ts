export interface ReportSchema<T> { parse(text: string): T }

export class StructuredReportParser<T> {
  constructor(private schema: ReportSchema<T>) {}
  parse(text: string): T { return this.schema.parse(text); }
}
