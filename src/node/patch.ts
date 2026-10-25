type Method = (this: unknown, ...args: unknown[]) => unknown

/** Restore only the method we own; application replacements always win. */
export function patchMethod(
  target: object,
  key: string,
  wrap: (original: Method) => Method,
): (() => void) | undefined {
  try {
    const own = Object.getOwnPropertyDescriptor(target, key)
    let descriptor = own
    let parent: object | null = target
    while (!descriptor && (parent = Object.getPrototypeOf(parent)))
      descriptor = Object.getOwnPropertyDescriptor(parent, key)
    if (!descriptor || !('value' in descriptor)) return
    if (typeof descriptor.value !== 'function') return
    if (own && !own.configurable && !own.writable) return
    if (!own && !Object.isExtensible(target)) return
    const wrapped = wrap(descriptor.value as Method)
    Object.defineProperty(
      target,
      key,
      own
        ? { ...own, value: wrapped }
        : { value: wrapped, writable: true, configurable: true },
    )
    let restored = false
    return () => {
      if (restored) return
      restored = true
      try {
        if (Object.getOwnPropertyDescriptor(target, key)?.value !== wrapped) return
        if (own) Object.defineProperty(target, key, own)
        else Reflect.deleteProperty(target, key)
      } catch {
        // A later application freeze must not make uninstall throw.
      }
    }
  } catch {
    // Proxies and exotic objects are outside the supported installation boundary.
    return
  }
}
