import { useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { MarkdownAnnotations } from '@deepseek-ai/dsh-client-ui-primitives'

const ABSENT_SOURCE: ObservableSnapshot<MarkdownAnnotations | undefined> = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
}

/**
 * Subscribe to the prose-annotation vocabulary observable.
 * @param source - current vocabulary observable, or absence for an unmounted provider.
 * @returns the current annotation resolver.
 */
export function useAnnotationsValue(
  source: ObservableSnapshot<MarkdownAnnotations | undefined> | undefined,
): MarkdownAnnotations | undefined {
  const observable = source ?? ABSENT_SOURCE
  return useSyncExternalStore(observable.subscribe, observable.getSnapshot)
}
