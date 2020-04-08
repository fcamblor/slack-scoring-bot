
declare namespace luxon {
  class DateTime {
    set(values: {hour: number, minutes: number}): DateTime;

    static fromMillis(ms: number, opts: {zone: string}): DateTime;
  }

  class Interval {
    contains(datetime: DateTime): boolean;

    static fromDateTimes(start: DateTime, end: DateTime): Interval;
  }

}