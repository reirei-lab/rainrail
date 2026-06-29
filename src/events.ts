export type RainrailEventSourceType = 'github' | 'cloudflare' | 'manual' | 'system' | (string & {});

export type RainrailEventName =
  | 'github.issue'
  | 'github.pull_request'
  | 'github.check_run'
  | 'github.review'
  | 'cloudflare.tail'
  | 'cloudflare.error'
  | (string & {});

export interface RainrailEventSource {
  type: RainrailEventSourceType;
  name: string;
  repository?: string;
  account?: string;
  environment?: string;
}

export interface RainrailEventDelivery {
  id: string;
  receivedAt: string;
}

export interface RainrailRawPayloadReference {
  kind: 'external-reference' | 'inline-redacted' | (string & {});
  reference: string;
  contentType?: string;
  sha256?: string;
}

export interface RainrailEventSubject {
  type: 'issue' | 'pull_request' | 'check_run' | 'review' | 'worker' | (string & {});
  id: string;
  url?: string;
}

export interface RainrailEventEnvelope<TPayload = unknown, TName extends RainrailEventName = RainrailEventName> {
  id: string;
  schemaVersion: 'rainrail.event.v1';
  source: RainrailEventSource;
  name: TName;
  delivery: RainrailEventDelivery;
  occurredAt: string;
  subject?: RainrailEventSubject;
  payload: TPayload;
  rawPayload: RainrailRawPayloadReference;
  links?: Record<string, string>;
}

export type RainrailEventEnvelopeInput<
  TPayload = unknown,
  TName extends RainrailEventName = RainrailEventName,
> = Omit<RainrailEventEnvelope<TPayload, TName>, 'id' | 'schemaVersion'> & {
  id?: string;
  schemaVersion?: 'rainrail.event.v1';
};

export function createEventEnvelope<TPayload, TName extends RainrailEventName>(
  input: RainrailEventEnvelopeInput<TPayload, TName>,
): RainrailEventEnvelope<TPayload, TName> {
  const schemaVersion = input.schemaVersion ?? 'rainrail.event.v1';
  const id = input.id ?? `${input.source.name}:${input.delivery.id}:${input.name}`;

  return {
    ...input,
    id,
    schemaVersion,
  };
}
