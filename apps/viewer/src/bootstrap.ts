export interface ViewerBootstrap {
  readonly token?: string;
  readonly sessionId?: string;
  readonly cleanPath: string;
}

const CONTROL_TOKEN = /^[A-Za-z\d_-]{43}$/u;

export function parseViewerBootstrap(
  url: URL,
  storedToken?: string | null,
): ViewerBootstrap {
  const fragment = new URLSearchParams(url.hash.slice(1));
  const fragmentToken = fragment.get("token");
  const token =
    fragmentToken !== null && CONTROL_TOKEN.test(fragmentToken)
      ? fragmentToken
      : storedToken !== undefined &&
          storedToken !== null &&
          CONTROL_TOKEN.test(storedToken)
        ? storedToken
        : undefined;
  const requestedSession =
    fragment.get("session") ?? url.searchParams.get("session") ?? undefined;
  const sessionId =
    requestedSession === undefined ||
    requestedSession.length === 0 ||
    requestedSession.length > 512
      ? undefined
      : requestedSession;
  const clean = new URL(url);
  clean.hash = "";
  if (sessionId !== undefined) {
    clean.searchParams.set("session", sessionId);
  }
  return {
    ...(token === undefined ? {} : { token }),
    ...(sessionId === undefined ? {} : { sessionId }),
    cleanPath: `${clean.pathname}${clean.search}`,
  };
}
