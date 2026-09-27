/** Identity of an existing reader affected by a repository filesystem hint. */
export type RepositoryConsumer = { feature: string; repo: string } | { flightId: string }

export const REPOSITORY_RECONCILE_MS = 30_000
export const REPOSITORY_FRESHNESS_MS = 45_000

export function repositoryConsumerKey(consumer: RepositoryConsumer): string {
  return 'flightId' in consumer
    ? JSON.stringify(['flight', consumer.flightId])
    : JSON.stringify(['repo', consumer.feature, consumer.repo])
}
