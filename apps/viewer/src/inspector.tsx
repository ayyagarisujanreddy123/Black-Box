import { useEffect, useMemo, useState } from "react";

import type {
  BlackBoxEvent,
  BlobReference,
  ContextCompleteness,
  ContextResult,
  EventDetail,
} from "@blackbox/protocol";

import type { ViewerApiClient } from "./api.js";
import {
  decodeFileDelta,
  numberedLines,
  type DecodedFileState,
} from "./diff.js";

type InspectorTab =
  | "summary"
  | "context"
  | "normalized"
  | "raw"
  | "headers"
  | "provenance"
  | "diff";

interface PayloadChoice {
  readonly label: string;
  readonly reference: BlobReference;
}

export interface InspectorProps {
  readonly api: ViewerApiClient;
  readonly detail?: EventDetail | undefined;
  readonly loading: boolean;
  readonly error?: string | undefined;
  readonly relatedEvents: readonly BlackBoxEvent[];
  readonly onSelectEvent: (eventId: string) => void;
}

export function JsonBlock(props: {
  readonly value: unknown;
}): React.JSX.Element {
  return (
    <pre className="json-block">{JSON.stringify(props.value, null, 2)}</pre>
  );
}

const CONTEXT_LABELS: Record<ContextCompleteness, string> = {
  "exact-client-request": "Exact client request",
  "reconstructed-client-chain": "Reconstructed client chain",
  "partial-client-chain": "Partial client chain",
  "provider-managed-context": "Provider-managed context",
  "unknown-unsupported": "Unknown or unsupported",
};

function tokenValue(value: number | null): string {
  return value === null ? "unavailable" : value.toLocaleString();
}

export function ContextView(props: {
  readonly context: ContextResult;
  readonly onSelectEvent?: (eventId: string) => void;
}): React.JSX.Element {
  const context = props.context;
  return (
    <div className="context-view">
      <section
        className={`context-completeness context-completeness--${context.completeness}`}
      >
        <span>Context completeness</span>
        <strong>{CONTEXT_LABELS[context.completeness]}</strong>
      </section>

      <dl className="context-metrics">
        <div>
          <dt>Reported input</dt>
          <dd>{tokenValue(context.reportedInputTokens)} tokens</dd>
        </div>
        <div>
          <dt>Visible estimate</dt>
          <dd>≈ {tokenValue(context.estimatedInputTokens)} tokens</dd>
        </div>
        <div>
          <dt>Model limit</dt>
          <dd>{tokenValue(context.modelContextLimit)} tokens</dd>
        </div>
      </dl>

      <p className="context-notice">{context.visibilityNotice}</p>

      {context.limitationReasons.length === 0 ? null : (
        <section className="context-limitations" aria-label="Limitations">
          <h3>Limitations</h3>
          <ul>
            {context.limitationReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      )}

      <h3>Ordered visible context</h3>
      {context.items.length === 0 ? (
        <p className="inspector-note">
          No API-visible context item was recovered.
        </p>
      ) : (
        <ol className="context-items">
          {context.items.map((item) => (
            <li key={item.id}>
              <header>
                <span>#{item.position}</span>
                <strong>{item.kind}</strong>
                {item.role === undefined ? null : <em>{item.role}</em>}
                <small>{item.evidence}</small>
              </header>
              <JsonBlock value={item.summary} />
              <footer>
                {item.provenance.eventId === undefined ||
                props.onSelectEvent === undefined ? (
                  <code>event {item.provenance.eventId ?? "none"}</code>
                ) : (
                  <button
                    type="button"
                    className="context-provenance-link"
                    onClick={() => {
                      if (item.provenance.eventId !== undefined) {
                        props.onSelectEvent?.(item.provenance.eventId);
                      }
                    }}
                  >
                    event {item.provenance.eventId}
                  </button>
                )}
                <code>exchange {item.provenance.exchangeId ?? "none"}</code>
                {item.provenance.payloadRef === undefined ? null : (
                  <code>payload {item.provenance.payloadRef.id}</code>
                )}
              </footer>
            </li>
          ))}
        </ol>
      )}

      <h3>Ancestry</h3>
      <div className="context-ancestry">
        <ul>
          {context.ancestry.nodes.map((node) => (
            <li key={node.id}>
              <span>{node.kind}</span>
              <code>{node.id}</code>
              <small>{node.locallyAvailable ? "local" : "not local"}</small>
            </li>
          ))}
        </ul>
        {context.ancestry.edges.length === 0 ? null : (
          <ol>
            {context.ancestry.edges.map((edge, index) => (
              <li key={`${edge.from}-${edge.to}-${edge.relation}-${index}`}>
                <code>{edge.from}</code>
                <span>{edge.relation}</span>
                <code>{edge.to}</code>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export function ContextPanel(props: {
  readonly api: ViewerApiClient;
  readonly eventId: string;
  readonly onSelectEvent: (eventId: string) => void;
}): React.JSX.Element {
  const [context, setContext] = useState<ContextResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    setContext(undefined);
    setError(undefined);
    void props.api
      .getContext(props.eventId)
      .then((result) => current && setContext(result))
      .catch((cause: unknown) => {
        if (current) {
          setError(
            cause instanceof Error ? cause.message : "Context unavailable",
          );
        }
      });
    return () => {
      current = false;
    };
  }, [props.api, props.eventId]);

  if (error !== undefined) {
    return <p className="error-banner">{error}</p>;
  }
  if (context === undefined) {
    return <p className="inspector-note">Reconstructing visible context…</p>;
  }
  return <ContextView context={context} onSelectEvent={props.onSelectEvent} />;
}

function payloadChoices(detail: EventDetail): PayloadChoice[] {
  const choices: PayloadChoice[] = [];
  if (detail.event.payloadRef !== undefined) {
    choices.push({
      label: "Event payload",
      reference: detail.event.payloadRef,
    });
  }
  const raw = detail.rawExchange;
  if (raw?.requestBodyRef !== undefined) {
    choices.push({ label: "Raw request", reference: raw.requestBodyRef });
  }
  if (raw?.responseBodyRef !== undefined) {
    choices.push({ label: "Raw response", reference: raw.responseBodyRef });
  }
  if (raw?.streamManifestRef !== undefined) {
    choices.push({
      label: "Stream manifest",
      reference: raw.streamManifestRef,
    });
  }
  return choices;
}

function renderPayload(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return [...bytes.slice(0, 512)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ");
  }
}

export function RawPayload(props: {
  readonly api: ViewerApiClient;
  readonly detail: EventDetail;
}): React.JSX.Element {
  const choices = useMemo(() => payloadChoices(props.detail), [props.detail]);
  const [selectedId, setSelectedId] = useState(choices[0]?.reference.id);
  const [bytes, setBytes] = useState<Uint8Array>();
  const [error, setError] = useState<string>();
  const selected = choices.find((choice) => choice.reference.id === selectedId);

  useEffect(() => {
    setSelectedId(choices[0]?.reference.id);
  }, [choices]);

  useEffect(() => {
    if (selected === undefined) {
      setBytes(undefined);
      return;
    }
    let current = true;
    setBytes(undefined);
    setError(undefined);
    void props.api
      .getPayload(selected.reference.id)
      .then((payload) => {
        if (current) {
          setBytes(payload);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setError(
            cause instanceof Error ? cause.message : "Payload unavailable",
          );
        }
      });
    return () => {
      current = false;
    };
  }, [props.api, selected]);

  if (choices.length === 0) {
    return (
      <p className="inspector-note">
        No raw payload reference is attached to this evidence.
      </p>
    );
  }
  return (
    <div className="payload-view">
      <label>
        Payload
        <select
          value={selectedId}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {choices.map((choice) => (
            <option
              key={`${choice.label}-${choice.reference.id}`}
              value={choice.reference.id}
            >
              {choice.label} · {choice.reference.byteLength.toLocaleString()}{" "}
              bytes
            </option>
          ))}
        </select>
      </label>
      {selected === undefined ? null : (
        <div className="payload-meta">
          <span>{selected.reference.mediaType}</span>
          <code>{selected.reference.sha256.slice(0, 16)}…</code>
          {selected.reference.truncated ? <strong>truncated</strong> : null}
        </div>
      )}
      {error === undefined ? null : <p className="error-banner">{error}</p>}
      {bytes === undefined && error === undefined ? (
        <p className="inspector-note">Loading verified payload bytes…</p>
      ) : null}
      {bytes === undefined ? null : (
        <pre className="raw-evidence" data-render-policy="inert-text-only">
          {renderPayload(bytes)}
        </pre>
      )}
    </div>
  );
}

function FileState(props: {
  readonly label: string;
  readonly state: DecodedFileState;
  readonly compare?: readonly string[];
}): React.JSX.Element {
  const lines = numberedLines(props.state.text);
  if (props.state.kind === "absent") {
    return <div className="diff-absent">{props.label}: file absent</div>;
  }
  if (props.state.kind === "binary") {
    return (
      <div className="diff-absent">
        {props.label}: binary · {props.state.byteLength.toLocaleString()} bytes
      </div>
    );
  }
  return (
    <section className="diff-side" aria-label={`${props.label} file content`}>
      <header>{props.label}</header>
      <pre>
        {lines.map((line, index) => (
          <span
            className={props.compare?.[index] === line ? "" : "is-changed"}
            key={`${index}-${line}`}
          >
            <em>{index + 1}</em>
            {line || " "}
            {"\n"}
          </span>
        ))}
      </pre>
    </section>
  );
}

function DiffPayload(props: {
  readonly api: ViewerApiClient;
  readonly detail: EventDetail;
}): React.JSX.Element {
  const reference = props.detail.event.payloadRef;
  const [bytes, setBytes] = useState<Uint8Array>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (reference === undefined) {
      return;
    }
    let current = true;
    setBytes(undefined);
    setError(undefined);
    void props.api
      .getPayload(reference.id)
      .then((payload) => current && setBytes(payload))
      .catch((cause: unknown) => {
        if (current) {
          setError(cause instanceof Error ? cause.message : "Diff unavailable");
        }
      });
    return () => {
      current = false;
    };
  }, [props.api, reference]);

  if (reference === undefined) {
    return (
      <p className="inspector-note">
        This change was hashed without retained content.
      </p>
    );
  }
  if (error !== undefined) {
    return <p className="error-banner">{error}</p>;
  }
  if (bytes === undefined) {
    return <p className="inspector-note">Loading diff evidence…</p>;
  }
  if (props.detail.fileChange?.payloadKind === "git-binary-patch") {
    return <pre className="raw-evidence">{renderPayload(bytes)}</pre>;
  }
  try {
    const delta = decodeFileDelta(bytes);
    const before = numberedLines(delta.before.text);
    const after = numberedLines(delta.after.text);
    return (
      <div className="diff-view">
        <div className="diff-path">
          <strong>{delta.payload.path}</strong>
          <span>{delta.payload.operation}</span>
        </div>
        <div className="diff-columns">
          <FileState label="before" state={delta.before} compare={after} />
          <FileState label="after" state={delta.after} compare={before} />
        </div>
      </div>
    );
  } catch (cause: unknown) {
    return (
      <div>
        <p className="error-banner">
          {cause instanceof Error ? cause.message : "Malformed diff evidence"}
        </p>
        <pre className="raw-evidence">{renderPayload(bytes)}</pre>
      </div>
    );
  }
}

function Summary(props: { readonly detail: EventDetail }): React.JSX.Element {
  const event = props.detail.event;
  return (
    <div className="summary-tab">
      <div className="evidence-stamps">
        <span>{event.source}</span>
        <span>{event.evidence}</span>
        <span>sequence {event.sequence}</span>
      </div>
      <dl className="summary-grid">
        {Object.entries(event.summary).map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
          </div>
        ))}
      </dl>
      {event.redaction.applied ? (
        <p className="redaction-banner">
          Redaction applied: {event.redaction.ruleIds.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function Headers(props: { readonly detail: EventDetail }): React.JSX.Element {
  if (props.detail.rawExchange === undefined) {
    return (
      <p className="inspector-note">
        No HTTP exchange is associated with this event.
      </p>
    );
  }
  return (
    <div>
      <p className="inspector-note">
        Credential and cookie headers are excluded before persistence.
      </p>
      <h3>Request</h3>
      <JsonBlock value={props.detail.rawExchange.requestHeaders} />
      <h3>Response</h3>
      <JsonBlock value={props.detail.rawExchange.responseHeaders ?? {}} />
    </div>
  );
}

function Provenance(props: {
  readonly detail: EventDetail;
  readonly relatedEvents: readonly BlackBoxEvent[];
  readonly onSelectEvent: (eventId: string) => void;
}): React.JSX.Element {
  return (
    <div className="provenance-tab">
      <dl className="summary-grid">
        <div>
          <dt>Evidence</dt>
          <dd>{props.detail.event.evidence}</dd>
        </div>
        <div>
          <dt>Observed</dt>
          <dd>{props.detail.event.observedAt}</dd>
        </div>
        <div>
          <dt>Normalization</dt>
          <dd>{props.detail.normalizationVersion ?? "native observation"}</dd>
        </div>
        <div>
          <dt>Raw exchange</dt>
          <dd>{props.detail.rawExchange?.id ?? "none"}</dd>
        </div>
        <div>
          <dt>Correlation</dt>
          <dd>{props.detail.event.correlationId ?? "none"}</dd>
        </div>
        <div>
          <dt>Parent</dt>
          <dd>{props.detail.event.parentId ?? "none"}</dd>
        </div>
      </dl>
      <h3>Linked evidence</h3>
      {props.relatedEvents.length === 0 ? (
        <p className="inspector-note">
          No linked event is present in the loaded timeline.
        </p>
      ) : (
        <div className="related-events">
          {props.relatedEvents.map((event) => (
            <button
              type="button"
              key={event.id}
              onClick={() => props.onSelectEvent(event.id)}
            >
              <span>#{event.sequence}</span>
              {event.type}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Inspector(props: InspectorProps): React.JSX.Element {
  const [tab, setTab] = useState<InspectorTab>("summary");
  const detail = props.detail;
  const tabs: InspectorTab[] = [
    "summary",
    ...(detail?.event.type === "model.request" ? (["context"] as const) : []),
    "normalized",
    "raw",
    "headers",
    "provenance",
    ...(detail?.fileChange === undefined ? [] : (["diff"] as const)),
  ];

  useEffect(() => setTab("summary"), [detail?.event.id]);

  if (props.loading) {
    return (
      <div className="inspector-state" role="status">
        Loading event evidence…
      </div>
    );
  }
  if (props.error !== undefined) {
    return <div className="inspector-state error-banner">{props.error}</div>;
  }
  if (detail === undefined) {
    return (
      <div className="inspector-state">
        Select an event to inspect its evidence.
      </div>
    );
  }

  return (
    <div className="inspector-content">
      <header className="inspector-heading">
        <span>event / {detail.event.source}</span>
        <h2>{detail.event.type}</h2>
        <code>{detail.event.id}</code>
      </header>
      <div
        className="inspector-tabs"
        role="tablist"
        aria-label="Evidence inspector"
      >
        {tabs.map((candidate) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === candidate}
            key={candidate}
            onClick={() => setTab(candidate)}
          >
            {candidate}
          </button>
        ))}
      </div>
      <div className="inspector-panel" role="tabpanel">
        {tab === "summary" ? <Summary detail={detail} /> : null}
        {tab === "context" ? (
          <ContextPanel
            api={props.api}
            eventId={detail.event.id}
            onSelectEvent={props.onSelectEvent}
          />
        ) : null}
        {tab === "normalized" ? <JsonBlock value={detail.event} /> : null}
        {tab === "raw" ? <RawPayload api={props.api} detail={detail} /> : null}
        {tab === "headers" ? <Headers detail={detail} /> : null}
        {tab === "provenance" ? (
          <Provenance
            detail={detail}
            relatedEvents={props.relatedEvents}
            onSelectEvent={props.onSelectEvent}
          />
        ) : null}
        {tab === "diff" ? (
          <DiffPayload api={props.api} detail={detail} />
        ) : null}
      </div>
    </div>
  );
}
