export function parseStrictOptions(argv, { allowed, boolean = new Set() }) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${argument}`);
    }
    const equals = argument.indexOf('=');
    const key = argument.slice(2, equals === -1 ? undefined : equals);
    if (!allowed.has(key)) throw new Error(`unknown option: --${key}`);
    if (Object.hasOwn(result, key)) throw new Error(`duplicate option: --${key}`);
    if (boolean.has(key)) {
      if (equals !== -1) throw new Error(`boolean option --${key} does not accept a value`);
      result[key] = true;
      continue;
    }
    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1);
    if (!value || value.startsWith('--')) throw new Error(`option --${key} requires a value`);
    result[key] = value;
    if (equals === -1) index += 1;
  }
  return result;
}
