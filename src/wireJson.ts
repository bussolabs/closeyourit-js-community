// Single JSON serializer for everything that goes on the wire (CYJS-76). Plain
// `JSON.stringify` throws on a `bigint` — a 64-bit id from a database driver in
// a context, an extra or a log attribute is enough — and that exception used to
// climb up to the host (on Node, through the log timer, it shut the server
// down). Here a `bigint` is written as a decimal string: it keeps every digit,
// while converting it to a number would silently lose the low ones.
//
// The send, the byte budget and the internal clone all go through here, so the
// size that is measured is the size that leaves. Values that remain
// unserializable (a cyclic object, a throwing `toJSON`) still throw: the
// caller drops that single payload and counts it as `error`.

function wireReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

/// JSON of [value] as it travels on the wire: `bigint` → decimal string.
/// `undefined` for values JSON cannot represent at the top level (`undefined`,
/// functions, symbols); throws on cycles and on throwing `toJSON` hooks.
export function toWireJson(value: unknown): string | undefined {
  return JSON.stringify(value, wireReplacer)
}
