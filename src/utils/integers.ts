export interface StrictIntegerOptions {
  min?: number;
  max?: number;
}

function integerMessage(name: string, options: StrictIntegerOptions): string {
  if (options.min !== undefined && options.max !== undefined) {
    return `${name} must be an integer from ${options.min} to ${options.max}`;
  }
  if (options.min !== undefined) {
    return `${name} must be an integer greater than or equal to ${options.min}`;
  }
  if (options.max !== undefined) {
    return `${name} must be an integer less than or equal to ${options.max}`;
  }
  return `${name} must be an integer`;
}

export function parseStrictInteger(value: string, name: string, options: StrictIntegerOptions = {}): number {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(integerMessage(name, options));
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(integerMessage(name, options));
  }

  if (options.min !== undefined && parsed < options.min) {
    throw new Error(integerMessage(name, options));
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new Error(integerMessage(name, options));
  }

  return parsed;
}
