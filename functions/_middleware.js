/**
 * Root middleware — redirects the old baliair.pages.dev domain to the
 * canonical baliairdispatch.com one, preserving path and query string.
 * A hostname-scoped rule in _redirects does not fire against the project's
 * own *.pages.dev domain, so this runs at the Functions layer instead,
 * which every request (static or Function-routed) passes through first.
 * Preview deployments (<hash>.baliair.pages.dev) are an exact-match miss
 * here on purpose — they must keep working unredirected.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === 'baliair.pages.dev') {
    url.hostname = 'baliairdispatch.com';
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
