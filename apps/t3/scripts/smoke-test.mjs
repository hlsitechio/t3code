import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("Could not resolve free port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", (error) => reject(error));
  });
}

function waitForProcessExit(processRef) {
  return new Promise((resolve) => {
    processRef.once("exit", (code) => resolve(code));
  });
}

async function terminateProcess(processRef, timeoutMs = 5_000) {
  if (processRef.exitCode !== null || processRef.signalCode !== null) {
    return;
  }

  processRef.kill("SIGTERM");
  const exited = await Promise.race([
    waitForProcessExit(processRef).then(() => true),
    new Promise((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);

  if (exited) {
    return;
  }

  processRef.kill("SIGKILL");
  await waitForProcessExit(processRef);
}

function waitForUnauthorizedCloseWithoutMessages(socket, label, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let messageCount = 0;
    const timer = setTimeout(() => {
      reject(new Error(`Smoke test failed: ${label} websocket close event timed out.`));
    }, timeoutMs);

    socket.addEventListener("message", () => {
      messageCount += 1;
    });
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      if (event.code !== 4001) {
        reject(
          new Error(
            `Smoke test failed: expected unauthorized close code 4001 for ${label}, received ${event.code}.`,
          ),
        );
        return;
      }
      if (messageCount > 0) {
        reject(
          new Error(
            `Smoke test failed: unauthorized websocket ${label} received ${messageCount} message(s) before close.`,
          ),
        );
        return;
      }
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`Smoke test failed: ${label} websocket client error before close.`));
    });
  });
}

function waitForCloseCode(socket, expectedCode, label, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Smoke test failed: ${label} websocket close event timed out.`));
    }, timeoutMs);

    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      if (event.code !== expectedCode) {
        reject(
          new Error(
            `Smoke test failed: expected ${label} close code ${expectedCode}, received ${event.code}.`,
          ),
        );
        return;
      }
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`Smoke test failed: ${label} websocket client error before close.`));
    });
  });
}

function sendWsRequest(socket, request, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(
        new Error(
          `Smoke test failed: websocket request ${request.id} (${request.method}) timed out.`,
        ),
      );
    }, timeoutMs);

    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (message.type !== "response" || message.id !== request.id) {
        return;
      }

      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };

    socket.addEventListener("message", onMessage);
    socket.send(
      JSON.stringify({
        type: "request",
        id: request.id,
        method: request.method,
        ...(request.params === undefined ? {} : { params: request.params }),
      }),
    );
  });
}

function waitForStartupUrl(readOutput, processRef, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearInterval(timer);
      processRef.off("exit", onExit);
      callback(value);
    };
    const onExit = (code) => {
      finish(
        reject,
        new Error(
          `Smoke test failed: CLI exited before startup URL was printed (exit code ${String(code)}).`,
        ),
      );
    };
    processRef.once("exit", onExit);

    const startedAt = Date.now();
    const timer = setInterval(() => {
      const output = readOutput();
      const match = output.match(/CodeThing is running at (http:\/\/[^\s]+)/);
      if (match?.[1]) {
        finish(resolve, match[1]);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        finish(reject, new Error("Smoke test failed: did not observe startup URL in CLI output."));
      }
    }, 100);
  });
}

async function main() {
  const [backendPort, webPort] = await Promise.all([getFreePort(), getFreePort()]);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const appRoot = path.resolve(scriptDir, "..");
  const distCli = path.join(appRoot, "dist", "cli.js");
  if (!fs.existsSync(distCli)) {
    throw new Error("Missing dist/cli.js. Run `bun run --cwd apps/t3 build` first.");
  }

  const child = spawn(
    process.execPath,
    [
      distCli,
      "-o=0",
      "--backend-port",
      String(backendPort),
      "--web-port",
      String(webPort),
    ],
    {
      cwd: appRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    const appUrl = await waitForStartupUrl(() => output, child);
    const parsedAppUrl = new URL(appUrl);

    const page = await fetch(parsedAppUrl);
    if (page.status !== 200) {
      throw new Error(`Smoke test failed: expected web status 200, received ${page.status}.`);
    }
    if (page.headers.get("x-content-type-options") !== "nosniff") {
      throw new Error("Smoke test failed: expected x-content-type-options=nosniff.");
    }
    if ((page.headers.get("x-frame-options") ?? "").toUpperCase() !== "DENY") {
      throw new Error("Smoke test failed: expected x-frame-options=DENY.");
    }
    if ((page.headers.get("referrer-policy") ?? "").toLowerCase() !== "no-referrer") {
      throw new Error("Smoke test failed: expected referrer-policy=no-referrer.");
    }
    if ((page.headers.get("cross-origin-resource-policy") ?? "").toLowerCase() !== "same-origin") {
      throw new Error("Smoke test failed: expected CORP header to be same-origin.");
    }
    if ((page.headers.get("cross-origin-opener-policy") ?? "").toLowerCase() !== "same-origin") {
      throw new Error("Smoke test failed: expected COOP header to be same-origin.");
    }
    if ((page.headers.get("cache-control") ?? "").toLowerCase() !== "no-store") {
      throw new Error(
        `Smoke test failed: expected cache-control=no-store, got ${String(
          page.headers.get("cache-control"),
        )}.`,
      );
    }
    if ((page.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") {
      throw new Error("Smoke test failed: expected accept-ranges=bytes on HTML response.");
    }
    if ((page.headers.get("vary") ?? "").toLowerCase() !== "range") {
      throw new Error("Smoke test failed: expected vary=range on HTML response.");
    }
    const html = await page.text();
    const assetMatch = html.match(/(?:src|href)="(\/assets\/[^"]+)"/);
    if (!assetMatch?.[1]) {
      throw new Error("Smoke test failed: could not locate built asset path in HTML.");
    }
    const assetUrl = new URL(assetMatch[1], parsedAppUrl);
    const assetResponse = await fetch(assetUrl);
    if (assetResponse.status !== 200) {
      throw new Error(
        `Smoke test failed: expected built asset status 200, received ${assetResponse.status}.`,
      );
    }
    const assetCacheControl = (assetResponse.headers.get("cache-control") ?? "").toLowerCase();
    if (!assetCacheControl.includes("immutable")) {
      throw new Error(
        `Smoke test failed: expected immutable cache-control on built asset, got ${String(
          assetResponse.headers.get("cache-control"),
        )}.`,
      );
    }
    if (!assetCacheControl.includes("max-age=31536000")) {
      throw new Error(
        `Smoke test failed: expected max-age=31536000 on built asset, got ${String(
          assetResponse.headers.get("cache-control"),
        )}.`,
      );
    }
    if ((assetResponse.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
      throw new Error("Smoke test failed: expected nosniff on built asset response.");
    }
    if ((assetResponse.headers.get("x-frame-options") ?? "").toUpperCase() !== "DENY") {
      throw new Error("Smoke test failed: expected x-frame-options=DENY on built asset response.");
    }
    if ((assetResponse.headers.get("referrer-policy") ?? "").toLowerCase() !== "no-referrer") {
      throw new Error("Smoke test failed: expected referrer-policy=no-referrer on built asset response.");
    }
    if ((assetResponse.headers.get("cross-origin-resource-policy") ?? "").toLowerCase() !== "same-origin") {
      throw new Error("Smoke test failed: expected CORP header on built asset response.");
    }
    if ((assetResponse.headers.get("cross-origin-opener-policy") ?? "").toLowerCase() !== "same-origin") {
      throw new Error("Smoke test failed: expected COOP header on built asset response.");
    }
    if ((assetResponse.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") {
      throw new Error("Smoke test failed: expected accept-ranges=bytes on built asset response.");
    }
    if ((assetResponse.headers.get("vary") ?? "").toLowerCase() !== "range") {
      throw new Error("Smoke test failed: expected vary=range on built asset response.");
    }
    const assetEtag = assetResponse.headers.get("etag");
    if (!assetEtag || assetEtag.length === 0) {
      throw new Error("Smoke test failed: expected ETag on built asset response.");
    }
    const assetContentType = assetResponse.headers.get("content-type");
    if (!assetContentType || assetContentType.length === 0) {
      throw new Error("Smoke test failed: expected content-type on built asset response.");
    }
    const assetLastModified = assetResponse.headers.get("last-modified");
    if (!assetLastModified || assetLastModified.length === 0) {
      throw new Error("Smoke test failed: expected Last-Modified on built asset response.");
    }
    const parsedLastModifiedMs = Date.parse(assetLastModified);
    if (!Number.isFinite(parsedLastModifiedMs)) {
      throw new Error(
        `Smoke test failed: expected parseable last-modified date, got ${assetLastModified}.`,
      );
    }
    const assetContentLength = Number(assetResponse.headers.get("content-length") ?? "0");
    if (!Number.isFinite(assetContentLength) || assetContentLength <= 0) {
      throw new Error(
        `Smoke test failed: expected positive content-length on built asset response, got ${String(
          assetResponse.headers.get("content-length"),
        )}.`,
      );
    }
    const conditionalAsset = await fetch(assetUrl, {
      headers: {
        "If-None-Match": assetEtag,
      },
    });
    if (conditionalAsset.status !== 304) {
      throw new Error(
        `Smoke test failed: expected conditional asset status 304, received ${conditionalAsset.status}.`,
      );
    }
    if (conditionalAsset.headers.get("etag") !== assetEtag) {
      throw new Error(
        `Smoke test failed: expected conditional asset ETag ${assetEtag}, got ${String(
          conditionalAsset.headers.get("etag"),
        )}.`,
      );
    }
    if (conditionalAsset.headers.get("content-type") !== assetContentType) {
      throw new Error(
        `Smoke test failed: expected conditional asset content-type ${assetContentType}, got ${String(
          conditionalAsset.headers.get("content-type"),
        )}.`,
      );
    }
    if ((conditionalAsset.headers.get("cache-control") ?? "").toLowerCase() !== assetCacheControl) {
      throw new Error("Smoke test failed: expected cache-control preserved on conditional asset response.");
    }
    if ((conditionalAsset.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
      throw new Error("Smoke test failed: expected nosniff on conditional asset response.");
    }
    if ((conditionalAsset.headers.get("x-frame-options") ?? "").toUpperCase() !== "DENY") {
      throw new Error("Smoke test failed: expected x-frame-options=DENY on conditional asset response.");
    }
    if ((conditionalAsset.headers.get("referrer-policy") ?? "").toLowerCase() !== "no-referrer") {
      throw new Error("Smoke test failed: expected referrer-policy=no-referrer on conditional asset response.");
    }
    if ((conditionalAsset.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") {
      throw new Error("Smoke test failed: expected accept-ranges=bytes on conditional asset response.");
    }
    if ((conditionalAsset.headers.get("vary") ?? "").toLowerCase() !== "range") {
      throw new Error("Smoke test failed: expected vary=range on conditional asset response.");
    }
    if (conditionalAsset.headers.get("last-modified") !== assetLastModified) {
      throw new Error(
        `Smoke test failed: expected conditional asset last-modified ${assetLastModified}, got ${String(
          conditionalAsset.headers.get("last-modified"),
        )}.`,
      );
    }
    const conditionalAssetContentLength = conditionalAsset.headers.get("content-length");
    if (conditionalAssetContentLength !== null && conditionalAssetContentLength !== "0") {
      throw new Error(
        `Smoke test failed: expected no content-length (or 0) on conditional asset response, got ${conditionalAssetContentLength}.`,
      );
    }
    const weakConditionalAsset = await fetch(assetUrl, {
      headers: {
        "If-None-Match": `W/${assetEtag}`,
      },
    });
    if (weakConditionalAsset.status !== 304) {
      throw new Error(
        `Smoke test failed: expected weak conditional asset status 304, received ${weakConditionalAsset.status}.`,
      );
    }
    const lowercaseWeakConditionalAsset = await fetch(assetUrl, {
      headers: {
        "If-None-Match": `w/${assetEtag}`,
      },
    });
    if (lowercaseWeakConditionalAsset.status !== 304) {
      throw new Error(
        `Smoke test failed: expected lowercase weak conditional asset status 304, received ${lowercaseWeakConditionalAsset.status}.`,
      );
    }
    const wildcardConditionalAsset = await fetch(assetUrl, {
      headers: {
        "If-None-Match": "*",
      },
    });
    if (wildcardConditionalAsset.status !== 304) {
      throw new Error(
        `Smoke test failed: expected wildcard conditional asset status 304, received ${wildcardConditionalAsset.status}.`,
      );
    }
    const modifiedSinceAsset = await fetch(assetUrl, {
      headers: {
        "If-Modified-Since": assetLastModified,
      },
    });
    if (modifiedSinceAsset.status !== 304) {
      throw new Error(
        `Smoke test failed: expected If-Modified-Since asset status 304, received ${modifiedSinceAsset.status}.`,
      );
    }
    const precedenceAsset = await fetch(assetUrl, {
      headers: {
        "If-Modified-Since": assetLastModified,
        "If-None-Match": "\"definitely-different-etag\"",
      },
    });
    if (precedenceAsset.status !== 200) {
      throw new Error(
        `Smoke test failed: expected If-None-Match precedence status 200, received ${precedenceAsset.status}.`,
      );
    }
    const ifMatchMismatchAsset = await fetch(assetUrl, {
      headers: {
        "If-Match": "\"definitely-different-etag\"",
      },
    });
    if (ifMatchMismatchAsset.status !== 412) {
      throw new Error(
        `Smoke test failed: expected If-Match mismatch status 412, received ${ifMatchMismatchAsset.status}.`,
      );
    }
    if ((ifMatchMismatchAsset.headers.get("content-type") ?? "").toLowerCase() !== "text/plain; charset=utf-8") {
      throw new Error(
        `Smoke test failed: expected plain-text content-type on If-Match mismatch response, got ${String(
          ifMatchMismatchAsset.headers.get("content-type"),
        )}.`,
      );
    }
    const ifMatchMismatchContentLength = Number(ifMatchMismatchAsset.headers.get("content-length") ?? "0");
    if (!Number.isFinite(ifMatchMismatchContentLength) || ifMatchMismatchContentLength <= 0) {
      throw new Error(
        `Smoke test failed: expected positive content-length on If-Match mismatch response, got ${String(
          ifMatchMismatchAsset.headers.get("content-length"),
        )}.`,
      );
    }
    if ((ifMatchMismatchAsset.headers.get("cache-control") ?? "").toLowerCase() !== "no-store") {
      throw new Error("Smoke test failed: expected cache-control=no-store on If-Match mismatch response.");
    }
    if ((ifMatchMismatchAsset.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
      throw new Error("Smoke test failed: expected nosniff on If-Match mismatch response.");
    }
    if ((ifMatchMismatchAsset.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") {
      throw new Error("Smoke test failed: expected accept-ranges=bytes on If-Match mismatch response.");
    }
    if ((ifMatchMismatchAsset.headers.get("vary") ?? "").toLowerCase() !== "range") {
      throw new Error("Smoke test failed: expected vary=range on If-Match mismatch response.");
    }
    const ifMatchLowercaseWeakAsset = await fetch(assetUrl, {
      headers: {
        "If-Match": `w/${assetEtag}`,
      },
    });
    if (ifMatchLowercaseWeakAsset.status !== 412) {
      throw new Error(
        `Smoke test failed: expected lowercase weak If-Match status 412, received ${ifMatchLowercaseWeakAsset.status}.`,
      );
    }
    const ifMatchWildcardAsset = await fetch(assetUrl, {
      headers: {
        "If-Match": "*",
      },
    });
    if (ifMatchWildcardAsset.status !== 200) {
      throw new Error(
        `Smoke test failed: expected wildcard If-Match status 200, received ${ifMatchWildcardAsset.status}.`,
      );
    }
    const ifMatchWithNoneMatchAsset = await fetch(assetUrl, {
      headers: {
        "If-Match": assetEtag,
        "If-None-Match": assetEtag,
      },
    });
    if (ifMatchWithNoneMatchAsset.status !== 304) {
      throw new Error(
        `Smoke test failed: expected If-Match + If-None-Match status 304, received ${ifMatchWithNoneMatchAsset.status}.`,
      );
    }
    const ifMatchWildcardWithNoneMatchAsset = await fetch(assetUrl, {
      headers: {
        "If-Match": "*",
        "If-None-Match": assetEtag,
      },
    });
    if (ifMatchWildcardWithNoneMatchAsset.status !== 304) {
      throw new Error(
        `Smoke test failed: expected wildcard If-Match + If-None-Match status 304, received ${ifMatchWildcardWithNoneMatchAsset.status}.`,
      );
    }
    const ifMatchWildcardWithNoneMatchHeadAsset = await fetch(assetUrl, {
      method: "HEAD",
      headers: {
        "If-Match": "*",
        "If-None-Match": assetEtag,
      },
    });
    if (ifMatchWildcardWithNoneMatchHeadAsset.status !== 304) {
      throw new Error(
        `Smoke test failed: expected HEAD wildcard If-Match + If-None-Match status 304, received ${ifMatchWildcardWithNoneMatchHeadAsset.status}.`,
      );
    }
    const ifMatchMismatchWithNoneMatchAsset = await fetch(assetUrl, {
      headers: {
        "If-Match": "\"definitely-different-etag\"",
        "If-None-Match": assetEtag,
      },
    });
    if (ifMatchMismatchWithNoneMatchAsset.status !== 412) {
      throw new Error(
        `Smoke test failed: expected mismatched If-Match + If-None-Match status 412, received ${ifMatchMismatchWithNoneMatchAsset.status}.`,
      );
    }
    const ifMatchWildcardRangedAsset = await fetch(assetUrl, {
      headers: {
        Range: "bytes=0-15",
        "If-Match": "*",
      },
    });
    if (ifMatchWildcardRangedAsset.status !== 206) {
      throw new Error(
        `Smoke test failed: expected wildcard If-Match ranged status 206, received ${ifMatchWildcardRangedAsset.status}.`,
      );
    }
    if (ifMatchMismatchAsset.headers.get("etag") !== assetEtag) {
      throw new Error("Smoke test failed: expected ETag on If-Match mismatch response.");
    }
    if (ifMatchMismatchAsset.headers.get("last-modified") !== assetLastModified) {
      throw new Error("Smoke test failed: expected Last-Modified on If-Match mismatch response.");
    }
    const ifMatchRangeMismatchAsset = await fetch(assetUrl, {
      headers: {
        Range: "bytes=0-15",
        "If-Match": "\"definitely-different-etag\"",
      },
    });
    if (ifMatchRangeMismatchAsset.status !== 412) {
      throw new Error(
        `Smoke test failed: expected ranged If-Match mismatch status 412, received ${ifMatchRangeMismatchAsset.status}.`,
      );
    }
    if (ifMatchRangeMismatchAsset.headers.get("content-range") !== null) {
      throw new Error(
        "Smoke test failed: expected no content-range on ranged If-Match mismatch response.",
      );
    }
    const staleUnmodifiedSince = new Date(parsedLastModifiedMs - 1_000).toUTCString();
    const staleUnmodifiedWithNoneMatchAsset = await fetch(assetUrl, {
      headers: {
        "If-Unmodified-Since": staleUnmodifiedSince,
        "If-None-Match": assetEtag,
      },
    });
    if (staleUnmodifiedWithNoneMatchAsset.status !== 412) {
      throw new Error(
        `Smoke test failed: expected stale If-Unmodified-Since + If-None-Match status 412, received ${staleUnmodifiedWithNoneMatchAsset.status}.`,
      );
    }
    const ifUnmodifiedSinceStaleAsset = await fetch(assetUrl, {
      headers: {
        "If-Unmodified-Since": staleUnmodifiedSince,
      },
    });
    if (ifUnmodifiedSinceStaleAsset.status !== 412) {
      throw new Error(
        `Smoke test failed: expected stale If-Unmodified-Since status 412, received ${ifUnmodifiedSinceStaleAsset.status}.`,
      );
    }
    if ((ifUnmodifiedSinceStaleAsset.headers.get("cache-control") ?? "").toLowerCase() !== "no-store") {
      throw new Error(
        "Smoke test failed: expected cache-control=no-store on stale If-Unmodified-Since response.",
      );
    }
    if ((ifUnmodifiedSinceStaleAsset.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") {
      throw new Error(
        "Smoke test failed: expected accept-ranges=bytes on stale If-Unmodified-Since response.",
      );
    }
    if (ifUnmodifiedSinceStaleAsset.headers.get("etag") !== assetEtag) {
      throw new Error("Smoke test failed: expected ETag on stale If-Unmodified-Since response.");
    }
    const ifUnmodifiedSinceRangeStaleAsset = await fetch(assetUrl, {
      headers: {
        Range: "bytes=0-15",
        "If-Unmodified-Since": staleUnmodifiedSince,
      },
    });
    if (ifUnmodifiedSinceRangeStaleAsset.status !== 412) {
      throw new Error(
        `Smoke test failed: expected ranged stale If-Unmodified-Since status 412, received ${ifUnmodifiedSinceRangeStaleAsset.status}.`,
      );
    }
    const ifUnmodifiedSinceCurrentAsset = await fetch(assetUrl, {
      headers: {
        "If-Unmodified-Since": assetLastModified,
      },
    });
    if (ifUnmodifiedSinceCurrentAsset.status !== 200) {
      throw new Error(
        `Smoke test failed: expected current If-Unmodified-Since status 200, received ${ifUnmodifiedSinceCurrentAsset.status}.`,
      );
    }
    const ifUnmodifiedSinceCurrentWithNoneMatch = await fetch(assetUrl, {
      headers: {
        "If-Unmodified-Since": assetLastModified,
        "If-None-Match": assetEtag,
      },
    });
    if (ifUnmodifiedSinceCurrentWithNoneMatch.status !== 304) {
      throw new Error(
        `Smoke test failed: expected current If-Unmodified-Since + If-None-Match status 304, received ${ifUnmodifiedSinceCurrentWithNoneMatch.status}.`,
      );
    }
    const ifUnmodifiedSinceCurrentWithNoneMatchRange = await fetch(assetUrl, {
      headers: {
        Range: "bytes=0-15",
        "If-Unmodified-Since": assetLastModified,
        "If-None-Match": assetEtag,
      },
    });
    if (ifUnmodifiedSinceCurrentWithNoneMatchRange.status !== 304) {
      throw new Error(
        `Smoke test failed: expected ranged current If-Unmodified-Since + If-None-Match status 304, received ${ifUnmodifiedSinceCurrentWithNoneMatchRange.status}.`,
      );
    }
    const ifMatchPrecedenceAsset = await fetch(assetUrl, {
      headers: {
        "If-Match": assetEtag,
        "If-Unmodified-Since": staleUnmodifiedSince,
      },
    });
    if (ifMatchPrecedenceAsset.status !== 200) {
      throw new Error(
        `Smoke test failed: expected If-Match precedence status 200, received ${ifMatchPrecedenceAsset.status}.`,
      );
    }
    const conditionalHeadAsset = await fetch(assetUrl, {
      method: "HEAD",
      headers: {
        "If-None-Match": assetEtag,
      },
    });
    if (conditionalHeadAsset.status !== 304) {
      throw new Error(
        `Smoke test failed: expected conditional HEAD asset status 304, received ${conditionalHeadAsset.status}.`,
      );
    }
    if (conditionalHeadAsset.headers.get("etag") !== assetEtag) {
      throw new Error(
        `Smoke test failed: expected conditional HEAD asset ETag ${assetEtag}, got ${String(
          conditionalHeadAsset.headers.get("etag"),
        )}.`,
      );
    }
    if (conditionalHeadAsset.headers.get("content-type") !== assetContentType) {
      throw new Error(
        `Smoke test failed: expected conditional HEAD asset content-type ${assetContentType}, got ${String(
          conditionalHeadAsset.headers.get("content-type"),
        )}.`,
      );
    }
    if ((conditionalHeadAsset.headers.get("cache-control") ?? "").toLowerCase() !== assetCacheControl) {
      throw new Error(
        "Smoke test failed: expected cache-control preserved on conditional HEAD asset response.",
      );
    }
    if ((conditionalHeadAsset.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
      throw new Error("Smoke test failed: expected nosniff on conditional HEAD asset response.");
    }
    if ((conditionalHeadAsset.headers.get("x-frame-options") ?? "").toUpperCase() !== "DENY") {
      throw new Error(
        "Smoke test failed: expected x-frame-options=DENY on conditional HEAD asset response.",
      );
    }
    if ((conditionalHeadAsset.headers.get("referrer-policy") ?? "").toLowerCase() !== "no-referrer") {
      throw new Error(
        "Smoke test failed: expected referrer-policy=no-referrer on conditional HEAD asset response.",
      );
    }
    if ((conditionalHeadAsset.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") {
      throw new Error(
        "Smoke test failed: expected accept-ranges=bytes on conditional HEAD asset response.",
      );
    }
    if ((conditionalHeadAsset.headers.get("vary") ?? "").toLowerCase() !== "range") {
      throw new Error("Smoke test failed: expected vary=range on conditional HEAD asset response.");
    }
    if (conditionalHeadAsset.headers.get("last-modified") !== assetLastModified) {
      throw new Error(
        `Smoke test failed: expected conditional HEAD asset last-modified ${assetLastModified}, got ${String(
          conditionalHeadAsset.headers.get("last-modified"),
        )}.`,
      );
    }
    const conditionalHeadAssetContentLength = conditionalHeadAsset.headers.get("content-length");
    if (
      conditionalHeadAssetContentLength !== null &&
      conditionalHeadAssetContentLength !== "0"
    ) {
      throw new Error(
        `Smoke test failed: expected no content-length (or 0) on conditional HEAD asset response, got ${conditionalHeadAssetContentLength}.`,
      );
    }
    const modifiedSinceHeadAsset = await fetch(assetUrl, {
      method: "HEAD",
      headers: {
        "If-Modified-Since": assetLastModified,
      },
    });
    if (modifiedSinceHeadAsset.status !== 304) {
      throw new Error(
        `Smoke test failed: expected If-Modified-Since HEAD asset status 304, received ${modifiedSinceHeadAsset.status}.`,
      );
    }
    const ifMatchMismatchHeadAsset = await fetch(assetUrl, {
      method: "HEAD",
      headers: {
        "If-Match": "\"definitely-different-etag\"",
      },
    });
    if (ifMatchMismatchHeadAsset.status !== 412) {
      throw new Error(
        `Smoke test failed: expected HEAD If-Match mismatch status 412, received ${ifMatchMismatchHeadAsset.status}.`,
      );
    }
    if (
      (ifMatchMismatchHeadAsset.headers.get("content-type") ?? "").toLowerCase() !==
      "text/plain; charset=utf-8"
    ) {
      throw new Error(
        `Smoke test failed: expected plain-text content-type on HEAD If-Match mismatch response, got ${String(
          ifMatchMismatchHeadAsset.headers.get("content-type"),
        )}.`,
      );
    }
    const ifMatchMismatchHeadContentLength = Number(
      ifMatchMismatchHeadAsset.headers.get("content-length") ?? "0",
    );
    if (!Number.isFinite(ifMatchMismatchHeadContentLength) || ifMatchMismatchHeadContentLength <= 0) {
      throw new Error(
        `Smoke test failed: expected positive content-length on HEAD If-Match mismatch response, got ${String(
          ifMatchMismatchHeadAsset.headers.get("content-length"),
        )}.`,
      );
    }
    if ((ifMatchMismatchHeadAsset.headers.get("cache-control") ?? "").toLowerCase() !== "no-store") {
      throw new Error(
        "Smoke test failed: expected cache-control=no-store on HEAD If-Match mismatch response.",
      );
    }
    if ((ifMatchMismatchHeadAsset.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") {
      throw new Error(
        "Smoke test failed: expected accept-ranges=bytes on HEAD If-Match mismatch response.",
      );
    }
    if ((ifMatchMismatchHeadAsset.headers.get("vary") ?? "").toLowerCase() !== "range") {
      throw new Error("Smoke test failed: expected vary=range on HEAD If-Match mismatch response.");
    }
    if (ifMatchMismatchHeadAsset.headers.get("etag") !== assetEtag) {
      throw new Error("Smoke test failed: expected ETag on HEAD If-Match mismatch response.");
    }
    if (ifMatchMismatchHeadAsset.headers.get("last-modified") !== assetLastModified) {
      throw new Error("Smoke test failed: expected Last-Modified on HEAD If-Match mismatch response.");
    }
    const ifUnmodifiedSinceStaleHeadAsset = await fetch(assetUrl, {
      method: "HEAD",
      headers: {
        "If-Unmodified-Since": staleUnmodifiedSince,
      },
    });
    if (ifUnmodifiedSinceStaleHeadAsset.status !== 412) {
      throw new Error(
        `Smoke test failed: expected HEAD stale If-Unmodified-Since status 412, received ${ifUnmodifiedSinceStaleHeadAsset.status}.`,
      );
    }
    if ((ifUnmodifiedSinceStaleHeadAsset.headers.get("cache-control") ?? "").toLowerCase() !== "no-store") {
      throw new Error(
        "Smoke test failed: expected cache-control=no-store on HEAD stale If-Unmodified-Since response.",
      );
    }
    if (ifUnmodifiedSinceStaleHeadAsset.headers.get("etag") !== assetEtag) {
      throw new Error(
        "Smoke test failed: expected ETag on HEAD stale If-Unmodified-Since response.",
      );
    }
    if (ifUnmodifiedSinceStaleHeadAsset.headers.get("last-modified") !== assetLastModified) {
      throw new Error(
        "Smoke test failed: expected Last-Modified on HEAD stale If-Unmodified-Since response.",
      );
    }
    const ifMatchRangeMismatchHeadAsset = await fetch(assetUrl, {
      method: "HEAD",
      headers: {
        Range: "bytes=0-15",
        "If-Match": "\"definitely-different-etag\"",
      },
    });
    if (ifMatchRangeMismatchHeadAsset.status !== 412) {
      throw new Error(
        `Smoke test failed: expected HEAD ranged If-Match mismatch status 412, received ${ifMatchRangeMismatchHeadAsset.status}.`,
      );
    }
    if (ifMatchRangeMismatchHeadAsset.headers.get("content-range") !== null) {
      throw new Error(
        "Smoke test failed: expected no content-range on HEAD ranged If-Match mismatch response.",
      );
    }
    const rangeEnd = Math.min(15, assetContentLength - 1);
    const rangedAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
      },
    });
    if (rangedAsset.status !== 206) {
      throw new Error(
        `Smoke test failed: expected ranged asset status 206, received ${rangedAsset.status}.`,
      );
    }
    const expectedContentRange = `bytes 0-${rangeEnd}/${assetContentLength}`;
    if (rangedAsset.headers.get("content-range") !== expectedContentRange) {
      throw new Error(
        `Smoke test failed: expected content-range ${expectedContentRange}, got ${String(
          rangedAsset.headers.get("content-range"),
        )}.`,
      );
    }
    const rangedContentLength = Number(rangedAsset.headers.get("content-length") ?? "0");
    if (!Number.isFinite(rangedContentLength) || rangedContentLength !== rangeEnd + 1) {
      throw new Error(
        `Smoke test failed: expected ranged content-length ${String(
          rangeEnd + 1,
        )}, got ${String(rangedAsset.headers.get("content-length"))}.`,
      );
    }
    if ((rangedAsset.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") {
      throw new Error("Smoke test failed: expected accept-ranges=bytes on ranged asset response.");
    }
    if ((rangedAsset.headers.get("vary") ?? "").toLowerCase() !== "range") {
      throw new Error("Smoke test failed: expected vary=range on ranged asset response.");
    }
    const oversizedSuffixRangedAsset = await fetch(assetUrl, {
      headers: {
        Range: "bytes=-999999",
      },
    });
    if (oversizedSuffixRangedAsset.status !== 206) {
      throw new Error(
        `Smoke test failed: expected oversized suffix range status 206, received ${oversizedSuffixRangedAsset.status}.`,
      );
    }
    if (oversizedSuffixRangedAsset.headers.get("content-range") !== `bytes 0-${assetContentLength - 1}/${assetContentLength}`) {
      throw new Error(
        `Smoke test failed: expected oversized suffix content-range bytes 0-${String(
          assetContentLength - 1,
        )}/${String(assetContentLength)}, got ${String(oversizedSuffixRangedAsset.headers.get("content-range"))}.`,
      );
    }
    const spacedRangedAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes = 0 - ${rangeEnd}`,
      },
    });
    if (spacedRangedAsset.status !== 206) {
      throw new Error(
        `Smoke test failed: expected spaced range asset status 206, received ${spacedRangedAsset.status}.`,
      );
    }
    const tabSpacedRangedAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes\t=\t0\t-\t${rangeEnd}`,
      },
    });
    if (tabSpacedRangedAsset.status !== 206) {
      throw new Error(
        `Smoke test failed: expected tab-spaced range asset status 206, received ${tabSpacedRangedAsset.status}.`,
      );
    }
    const conditionalRangedAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "If-None-Match": assetEtag,
      },
    });
    if (conditionalRangedAsset.status !== 304) {
      throw new Error(
        `Smoke test failed: expected conditional ranged asset status 304, received ${conditionalRangedAsset.status}.`,
      );
    }
    if (conditionalRangedAsset.headers.get("content-range") !== null) {
      throw new Error(
        "Smoke test failed: expected no content-range on conditional ranged If-None-Match response.",
      );
    }
    const wildcardConditionalRangedAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "If-None-Match": "*",
      },
    });
    if (wildcardConditionalRangedAsset.status !== 304) {
      throw new Error(
        `Smoke test failed: expected wildcard conditional ranged asset status 304, received ${wildcardConditionalRangedAsset.status}.`,
      );
    }
    if (wildcardConditionalRangedAsset.headers.get("content-range") !== null) {
      throw new Error(
        "Smoke test failed: expected no content-range on wildcard conditional ranged response.",
      );
    }
    const mismatchConditionalRangedAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "If-None-Match": "\"definitely-different-etag\"",
      },
    });
    if (mismatchConditionalRangedAsset.status !== 206) {
      throw new Error(
        `Smoke test failed: expected mismatched conditional ranged asset status 206, received ${mismatchConditionalRangedAsset.status}.`,
      );
    }
    const ifRangeEtagAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "If-Range": assetEtag,
      },
    });
    if (ifRangeEtagAsset.status !== 206) {
      throw new Error(
        `Smoke test failed: expected If-Range(etag) asset status 206, received ${ifRangeEtagAsset.status}.`,
      );
    }
    const ifRangeDateAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "If-Range": assetLastModified,
      },
    });
    if (ifRangeDateAsset.status !== 206) {
      throw new Error(
        `Smoke test failed: expected If-Range(date) asset status 206, received ${ifRangeDateAsset.status}.`,
      );
    }
    const staleIfRangeDate = new Date(parsedLastModifiedMs - 1_000).toUTCString();
    const ifRangeStaleDateAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "If-Range": staleIfRangeDate,
      },
    });
    if (ifRangeStaleDateAsset.status !== 200) {
      throw new Error(
        `Smoke test failed: expected stale If-Range(date) asset status 200, received ${ifRangeStaleDateAsset.status}.`,
      );
    }
    const ifRangeInvalidDateAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "If-Range": "not-a-date",
      },
    });
    if (ifRangeInvalidDateAsset.status !== 200) {
      throw new Error(
        `Smoke test failed: expected invalid If-Range(date) asset status 200, received ${ifRangeInvalidDateAsset.status}.`,
      );
    }
    const rangedModifiedSinceAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "If-Modified-Since": assetLastModified,
      },
    });
    if (rangedModifiedSinceAsset.status !== 304) {
      throw new Error(
        `Smoke test failed: expected ranged If-Modified-Since asset status 304, received ${rangedModifiedSinceAsset.status}.`,
      );
    }
    if (rangedModifiedSinceAsset.headers.get("content-range") !== null) {
      throw new Error(
        "Smoke test failed: expected no content-range on ranged If-Modified-Since response.",
      );
    }
    const staleModifiedSince = new Date(parsedLastModifiedMs - 1_000).toUTCString();
    const staleRangedModifiedSinceAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "If-Modified-Since": staleModifiedSince,
      },
    });
    if (staleRangedModifiedSinceAsset.status !== 206) {
      throw new Error(
        `Smoke test failed: expected stale ranged If-Modified-Since status 206, received ${staleRangedModifiedSinceAsset.status}.`,
      );
    }
    const ifRangeMismatchAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "If-Range": "\"definitely-different-etag\"",
      },
    });
    if (ifRangeMismatchAsset.status !== 200) {
      throw new Error(
        `Smoke test failed: expected If-Range mismatch asset status 200, received ${ifRangeMismatchAsset.status}.`,
      );
    }
    if (ifRangeMismatchAsset.headers.get("content-range") !== null) {
      throw new Error("Smoke test failed: expected no content-range on If-Range mismatch response.");
    }
    const ifRangeMismatchLength = Number(ifRangeMismatchAsset.headers.get("content-length") ?? "0");
    if (!Number.isFinite(ifRangeMismatchLength) || ifRangeMismatchLength !== assetContentLength) {
      throw new Error(
        `Smoke test failed: expected full content-length ${String(
          assetContentLength,
        )} on If-Range mismatch response, got ${String(ifRangeMismatchAsset.headers.get("content-length"))}.`,
      );
    }
    const ifRangeWeakAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "If-Range": `W/${assetEtag}`,
      },
    });
    if (ifRangeWeakAsset.status !== 200) {
      throw new Error(
        `Smoke test failed: expected If-Range weak-etag asset status 200, received ${ifRangeWeakAsset.status}.`,
      );
    }
    const ifRangeLowercaseWeakAsset = await fetch(assetUrl, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "If-Range": `w/${assetEtag}`,
      },
    });
    if (ifRangeLowercaseWeakAsset.status !== 200) {
      throw new Error(
        `Smoke test failed: expected If-Range lowercase weak-etag asset status 200, received ${ifRangeLowercaseWeakAsset.status}.`,
      );
    }
    if (ifRangeWeakAsset.headers.get("content-range") !== null) {
      throw new Error("Smoke test failed: expected no content-range on If-Range weak-etag response.");
    }
    const unsatisfiableRange = await fetch(assetUrl, {
      headers: {
        Range: `bytes=${assetContentLength}-${assetContentLength + 10}`,
      },
    });
    if (unsatisfiableRange.status !== 416) {
      throw new Error(
        `Smoke test failed: expected unsatisfiable range status 416, received ${unsatisfiableRange.status}.`,
      );
    }
    if (unsatisfiableRange.headers.get("content-range") !== `bytes */${assetContentLength}`) {
      throw new Error(
        `Smoke test failed: expected unsatisfiable content-range bytes */${String(
          assetContentLength,
        )}, got ${String(unsatisfiableRange.headers.get("content-range"))}.`,
      );
    }
    if (unsatisfiableRange.headers.get("etag") !== assetEtag) {
      throw new Error("Smoke test failed: expected ETag on unsatisfiable range response.");
    }
    if (unsatisfiableRange.headers.get("last-modified") !== assetLastModified) {
      throw new Error("Smoke test failed: expected Last-Modified on unsatisfiable range response.");
    }
    if ((unsatisfiableRange.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") {
      throw new Error(
        "Smoke test failed: expected accept-ranges=bytes on unsatisfiable range response.",
      );
    }
    if ((unsatisfiableRange.headers.get("vary") ?? "").toLowerCase() !== "range") {
      throw new Error("Smoke test failed: expected vary=range on unsatisfiable range response.");
    }
    if ((unsatisfiableRange.headers.get("cache-control") ?? "").toLowerCase() !== "no-store") {
      throw new Error(
        "Smoke test failed: expected cache-control=no-store on unsatisfiable range response.",
      );
    }
    const headAssetResponse = await fetch(assetUrl, { method: "HEAD" });
    if (headAssetResponse.status !== 200) {
      throw new Error(
        `Smoke test failed: expected HEAD asset status 200, received ${headAssetResponse.status}.`,
      );
    }
    const headAssetContentLength = Number(headAssetResponse.headers.get("content-length") ?? "0");
    if (!Number.isFinite(headAssetContentLength) || headAssetContentLength <= 0) {
      throw new Error(
        `Smoke test failed: expected positive content-length on HEAD asset response, got ${String(
          headAssetResponse.headers.get("content-length"),
        )}.`,
      );
    }
    const headAssetCacheControl = (headAssetResponse.headers.get("cache-control") ?? "").toLowerCase();
    if (!headAssetCacheControl.includes("immutable")) {
      throw new Error(
        `Smoke test failed: expected immutable cache-control on HEAD asset response, got ${String(
          headAssetResponse.headers.get("cache-control"),
        )}.`,
      );
    }
    if ((headAssetResponse.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
      throw new Error("Smoke test failed: expected nosniff on HEAD asset response.");
    }
    if ((headAssetResponse.headers.get("x-frame-options") ?? "").toUpperCase() !== "DENY") {
      throw new Error("Smoke test failed: expected x-frame-options=DENY on HEAD asset response.");
    }
    if ((headAssetResponse.headers.get("referrer-policy") ?? "").toLowerCase() !== "no-referrer") {
      throw new Error("Smoke test failed: expected referrer-policy=no-referrer on HEAD asset response.");
    }
    if (
      (headAssetResponse.headers.get("cross-origin-resource-policy") ?? "").toLowerCase() !==
      "same-origin"
    ) {
      throw new Error("Smoke test failed: expected CORP on HEAD asset response.");
    }
    if (
      (headAssetResponse.headers.get("cross-origin-opener-policy") ?? "").toLowerCase() !==
      "same-origin"
    ) {
      throw new Error("Smoke test failed: expected COOP on HEAD asset response.");
    }
    if ((headAssetResponse.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") {
      throw new Error("Smoke test failed: expected accept-ranges=bytes on HEAD asset response.");
    }
    if ((headAssetResponse.headers.get("vary") ?? "").toLowerCase() !== "range") {
      throw new Error("Smoke test failed: expected vary=range on HEAD asset response.");
    }
    if (headAssetResponse.headers.get("etag") !== assetEtag) {
      throw new Error(
        `Smoke test failed: expected HEAD asset ETag ${assetEtag}, got ${String(
          headAssetResponse.headers.get("etag"),
        )}.`,
      );
    }
    if (!headAssetResponse.headers.get("last-modified")) {
      throw new Error("Smoke test failed: expected last-modified on HEAD asset response.");
    }
    const headRangedAsset = await fetch(assetUrl, {
      method: "HEAD",
      headers: {
        Range: `bytes=0-${rangeEnd}`,
      },
    });
    if (headRangedAsset.status !== 206) {
      throw new Error(
        `Smoke test failed: expected HEAD ranged asset status 206, received ${headRangedAsset.status}.`,
      );
    }
    if (headRangedAsset.headers.get("content-range") !== expectedContentRange) {
      throw new Error(
        `Smoke test failed: expected HEAD ranged content-range ${expectedContentRange}, got ${String(
          headRangedAsset.headers.get("content-range"),
        )}.`,
      );
    }
    const headRangedContentLength = Number(headRangedAsset.headers.get("content-length") ?? "0");
    if (!Number.isFinite(headRangedContentLength) || headRangedContentLength !== rangeEnd + 1) {
      throw new Error(
        `Smoke test failed: expected HEAD ranged content-length ${String(
          rangeEnd + 1,
        )}, got ${String(headRangedAsset.headers.get("content-length"))}.`,
      );
    }
    if ((headRangedAsset.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") {
      throw new Error(
        "Smoke test failed: expected accept-ranges=bytes on HEAD ranged asset response.",
      );
    }
    if ((headRangedAsset.headers.get("vary") ?? "").toLowerCase() !== "range") {
      throw new Error("Smoke test failed: expected vary=range on HEAD ranged asset response.");
    }
    const headIfRangeMismatch = await fetch(assetUrl, {
      method: "HEAD",
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "If-Range": "\"definitely-different-etag\"",
      },
    });
    if (headIfRangeMismatch.status !== 200) {
      throw new Error(
        `Smoke test failed: expected HEAD If-Range mismatch status 200, received ${headIfRangeMismatch.status}.`,
      );
    }
    if (headIfRangeMismatch.headers.get("content-range") !== null) {
      throw new Error("Smoke test failed: expected no content-range on HEAD If-Range mismatch response.");
    }
    const headUnsatisfiableRange = await fetch(assetUrl, {
      method: "HEAD",
      headers: {
        Range: `bytes=${assetContentLength}-${assetContentLength + 1}`,
      },
    });
    if (headUnsatisfiableRange.status !== 416) {
      throw new Error(
        `Smoke test failed: expected HEAD unsatisfiable range status 416, received ${headUnsatisfiableRange.status}.`,
      );
    }
    if (headUnsatisfiableRange.headers.get("content-range") !== `bytes */${assetContentLength}`) {
      throw new Error(
        `Smoke test failed: expected HEAD unsatisfiable content-range bytes */${String(
          assetContentLength,
        )}, got ${String(headUnsatisfiableRange.headers.get("content-range"))}.`,
      );
    }
    if (headUnsatisfiableRange.headers.get("etag") !== assetEtag) {
      throw new Error("Smoke test failed: expected ETag on HEAD unsatisfiable range response.");
    }
    if (headUnsatisfiableRange.headers.get("last-modified") !== assetLastModified) {
      throw new Error("Smoke test failed: expected Last-Modified on HEAD unsatisfiable range response.");
    }
    if ((headUnsatisfiableRange.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") {
      throw new Error(
        "Smoke test failed: expected accept-ranges=bytes on HEAD unsatisfiable range response.",
      );
    }
    if ((headUnsatisfiableRange.headers.get("vary") ?? "").toLowerCase() !== "range") {
      throw new Error(
        "Smoke test failed: expected vary=range on HEAD unsatisfiable range response.",
      );
    }
    if ((headUnsatisfiableRange.headers.get("cache-control") ?? "").toLowerCase() !== "no-store") {
      throw new Error(
        "Smoke test failed: expected cache-control=no-store on HEAD unsatisfiable range response.",
      );
    }
    const missingAssetUrl = new URL("/assets/missing-bundle.js", parsedAppUrl);
    const missingAsset = await fetch(missingAssetUrl);
    if (missingAsset.status !== 404) {
      throw new Error(
        `Smoke test failed: expected missing asset status 404, received ${missingAsset.status}.`,
      );
    }
    if ((missingAsset.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
      throw new Error("Smoke test failed: expected nosniff on missing asset response.");
    }
    if ((missingAsset.headers.get("x-frame-options") ?? "").toUpperCase() !== "DENY") {
      throw new Error("Smoke test failed: expected x-frame-options=DENY on missing asset response.");
    }
    if ((missingAsset.headers.get("referrer-policy") ?? "").toLowerCase() !== "no-referrer") {
      throw new Error("Smoke test failed: expected referrer-policy=no-referrer on missing asset.");
    }
    if (
      (missingAsset.headers.get("cross-origin-resource-policy") ?? "").toLowerCase() !==
      "same-origin"
    ) {
      throw new Error("Smoke test failed: expected CORP header on missing asset response.");
    }
    if (
      (missingAsset.headers.get("cross-origin-opener-policy") ?? "").toLowerCase() !==
      "same-origin"
    ) {
      throw new Error("Smoke test failed: expected COOP header on missing asset response.");
    }
    if ((missingAsset.headers.get("cache-control") ?? "").toLowerCase() !== "no-store") {
      throw new Error("Smoke test failed: expected cache-control=no-store on missing asset.");
    }
    const headMissingAsset = await fetch(missingAssetUrl, { method: "HEAD" });
    if (headMissingAsset.status !== 404) {
      throw new Error(
        `Smoke test failed: expected HEAD missing asset status 404, received ${headMissingAsset.status}.`,
      );
    }
    if ((headMissingAsset.headers.get("cache-control") ?? "").toLowerCase() !== "no-store") {
      throw new Error(
        "Smoke test failed: expected cache-control=no-store on HEAD missing asset response.",
      );
    }
    const headMissingAssetContentLength = Number(
      headMissingAsset.headers.get("content-length") ?? "0",
    );
    if (!Number.isFinite(headMissingAssetContentLength) || headMissingAssetContentLength <= 0) {
      throw new Error(
        `Smoke test failed: expected positive content-length on HEAD missing asset response, got ${String(
          headMissingAsset.headers.get("content-length"),
        )}.`,
      );
    }
    if ((headMissingAsset.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
      throw new Error("Smoke test failed: expected nosniff on HEAD missing asset response.");
    }
    if ((headMissingAsset.headers.get("x-frame-options") ?? "").toUpperCase() !== "DENY") {
      throw new Error(
        "Smoke test failed: expected x-frame-options=DENY on HEAD missing asset response.",
      );
    }
    if ((headMissingAsset.headers.get("referrer-policy") ?? "").toLowerCase() !== "no-referrer") {
      throw new Error(
        "Smoke test failed: expected referrer-policy=no-referrer on HEAD missing asset response.",
      );
    }
    if (
      (headMissingAsset.headers.get("cross-origin-resource-policy") ?? "").toLowerCase() !==
      "same-origin"
    ) {
      throw new Error("Smoke test failed: expected CORP on HEAD missing asset response.");
    }
    if (
      (headMissingAsset.headers.get("cross-origin-opener-policy") ?? "").toLowerCase() !==
      "same-origin"
    ) {
      throw new Error("Smoke test failed: expected COOP on HEAD missing asset response.");
    }
    const postPage = await fetch(parsedAppUrl, {
      method: "POST",
      body: "noop",
    });
    if (postPage.status !== 405) {
      throw new Error(`Smoke test failed: expected POST status 405, received ${postPage.status}.`);
    }
    if ((postPage.headers.get("allow") ?? "").toLowerCase() !== "get, head") {
      throw new Error(
        `Smoke test failed: expected Allow header 'GET, HEAD', got ${String(
          postPage.headers.get("allow"),
        )}.`,
      );
    }
    if ((postPage.headers.get("content-type") ?? "").toLowerCase() !== "text/plain; charset=utf-8") {
      throw new Error(
        `Smoke test failed: expected plain-text POST error content-type, got ${String(
          postPage.headers.get("content-type"),
        )}.`,
      );
    }
    const postContentLength = Number(postPage.headers.get("content-length") ?? "0");
    if (!Number.isFinite(postContentLength) || postContentLength <= 0) {
      throw new Error(
        `Smoke test failed: expected positive content-length on POST response, got ${String(
          postPage.headers.get("content-length"),
        )}.`,
      );
    }
    if ((postPage.headers.get("cache-control") ?? "").toLowerCase() !== "no-store") {
      throw new Error("Smoke test failed: expected cache-control=no-store on POST response.");
    }
    if ((postPage.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
      throw new Error("Smoke test failed: expected nosniff on POST response.");
    }
    if ((postPage.headers.get("x-frame-options") ?? "").toUpperCase() !== "DENY") {
      throw new Error("Smoke test failed: expected x-frame-options=DENY on POST response.");
    }
    if ((postPage.headers.get("referrer-policy") ?? "").toLowerCase() !== "no-referrer") {
      throw new Error("Smoke test failed: expected referrer-policy=no-referrer on POST response.");
    }
    if ((postPage.headers.get("cross-origin-resource-policy") ?? "").toLowerCase() !== "same-origin") {
      throw new Error("Smoke test failed: expected CORP header on POST response.");
    }
    if ((postPage.headers.get("cross-origin-opener-policy") ?? "").toLowerCase() !== "same-origin") {
      throw new Error("Smoke test failed: expected COOP header on POST response.");
    }
    const headPage = await fetch(parsedAppUrl, { method: "HEAD" });
    if (headPage.status !== 200) {
      throw new Error(
        `Smoke test failed: expected HEAD web status 200, received ${headPage.status}.`,
      );
    }
    if ((headPage.headers.get("cache-control") ?? "").toLowerCase() !== "no-store") {
      throw new Error(
        `Smoke test failed: expected HEAD cache-control=no-store, got ${String(
          headPage.headers.get("cache-control"),
        )}.`,
      );
    }
    if ((headPage.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
      throw new Error("Smoke test failed: expected nosniff on HEAD app response.");
    }
    if ((headPage.headers.get("x-frame-options") ?? "").toUpperCase() !== "DENY") {
      throw new Error("Smoke test failed: expected x-frame-options=DENY on HEAD app response.");
    }
    if ((headPage.headers.get("referrer-policy") ?? "").toLowerCase() !== "no-referrer") {
      throw new Error("Smoke test failed: expected referrer-policy=no-referrer on HEAD app response.");
    }
    if ((headPage.headers.get("cross-origin-resource-policy") ?? "").toLowerCase() !== "same-origin") {
      throw new Error("Smoke test failed: expected CORP header on HEAD app response.");
    }
    if ((headPage.headers.get("cross-origin-opener-policy") ?? "").toLowerCase() !== "same-origin") {
      throw new Error("Smoke test failed: expected COOP header on HEAD app response.");
    }
    if ((headPage.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") {
      throw new Error("Smoke test failed: expected accept-ranges=bytes on HEAD app response.");
    }
    if ((headPage.headers.get("vary") ?? "").toLowerCase() !== "range") {
      throw new Error("Smoke test failed: expected vary=range on HEAD app response.");
    }
    const headContentLength = Number(headPage.headers.get("content-length") ?? "0");
    if (!Number.isFinite(headContentLength) || headContentLength <= 0) {
      throw new Error(
        `Smoke test failed: expected positive content-length for HEAD response, got ${String(
          headPage.headers.get("content-length"),
        )}.`,
      );
    }

    const wsUrl = parsedAppUrl.searchParams.get("ws");
    if (!wsUrl) {
      throw new Error("Smoke test failed: launch URL did not include ws runtime parameter.");
    }
    const parsedWsUrl = new URL(wsUrl);
    if (parsedWsUrl.port !== String(backendPort)) {
      throw new Error(
        `Smoke test failed: expected backend port ${backendPort}, got ${parsedWsUrl.port}.`,
      );
    }
    if (!parsedWsUrl.searchParams.get("token")) {
      throw new Error("Smoke test failed: websocket URL is missing runtime auth token.");
    }

    const unauthorizedWsUrl = `${parsedWsUrl.origin}${parsedWsUrl.pathname}`;
    const unauthorizedWs = new WebSocket(unauthorizedWsUrl);
    await waitForUnauthorizedCloseWithoutMessages(unauthorizedWs, "missing-token");

    const wrongTokenWs = new WebSocket(
      `${parsedWsUrl.origin}${parsedWsUrl.pathname}?token=wrong-token`,
    );
    await waitForUnauthorizedCloseWithoutMessages(wrongTokenWs, "wrong-token");

    const emptyTokenWs = new WebSocket(`${parsedWsUrl.origin}${parsedWsUrl.pathname}?token=`);
    await waitForUnauthorizedCloseWithoutMessages(emptyTokenWs, "empty-token");

    const whitespaceTokenWs = new WebSocket(
      `${parsedWsUrl.origin}${parsedWsUrl.pathname}?token=%20%20`,
    );
    await waitForUnauthorizedCloseWithoutMessages(whitespaceTokenWs, "whitespace-token");

    const duplicateTokenWs = new WebSocket(
      `${parsedWsUrl.origin}${parsedWsUrl.pathname}?token=${encodeURIComponent(
        parsedWsUrl.searchParams.get("token") ?? "",
      )}&token=wrong-token`,
    );
    await waitForUnauthorizedCloseWithoutMessages(duplicateTokenWs, "duplicate-token");

    const extraParamTokenWs = new WebSocket(
      `${parsedWsUrl.origin}${parsedWsUrl.pathname}?token=${encodeURIComponent(
        parsedWsUrl.searchParams.get("token") ?? "",
      )}&debug=1`,
    );
    await waitForUnauthorizedCloseWithoutMessages(extraParamTokenWs, "extra-param-token");

    const wrongPathTokenWs = new WebSocket(
      `${parsedWsUrl.origin}/unexpected?token=${encodeURIComponent(
        parsedWsUrl.searchParams.get("token") ?? "",
      )}`,
    );
    await waitForUnauthorizedCloseWithoutMessages(wrongPathTokenWs, "wrong-path-token");

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      let sawHello = false;
      let sawHealthResponse = false;
      const tryResolve = () => {
        if (sawHello && sawHealthResponse) {
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(
        () => reject(new Error("Smoke test failed: websocket did not respond in time.")),
        20_000,
      );
      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "request",
            id: "smoke",
            method: "app.health",
          }),
        );
      });
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "hello") {
          if (message.version !== 1) {
            clearTimeout(timer);
            reject(
              new Error(
                `Smoke test failed: expected hello version 1, got ${String(message.version)}.`,
              ),
            );
            return;
          }
          if (message.launchCwd !== appRoot) {
            clearTimeout(timer);
            reject(
              new Error(
                `Smoke test failed: expected hello launch cwd ${appRoot}, got ${String(
                  message.launchCwd,
                )}.`,
              ),
            );
            return;
          }
          sawHello = true;
          tryResolve();
          return;
        }
        if (message.type !== "response" || message.id !== "smoke" || message.ok !== true) {
          return;
        }
        if (message.result?.status !== "ok") {
          return;
        }
        if (message.result?.launchCwd !== appRoot) {
          clearTimeout(timer);
          reject(
            new Error(
              `Smoke test failed: expected launch cwd ${appRoot}, got ${String(
                message.result?.launchCwd,
              )}.`,
            ),
          );
          return;
        }
        if (message.result?.activeClientConnected !== true) {
          clearTimeout(timer);
          reject(
            new Error(
              "Smoke test failed: app.health did not report active websocket client connectivity.",
            ),
          );
          return;
        }
        if (!Number.isInteger(message.result?.sessionCount) || message.result.sessionCount < 0) {
          clearTimeout(timer);
          reject(
            new Error(
              `Smoke test failed: expected non-negative integer sessionCount, got ${String(
                message.result?.sessionCount,
              )}.`,
            ),
          );
          return;
        }

        sawHealthResponse = true;
        tryResolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Smoke test failed: websocket client error."));
      });
    });

    const bootstrapResponse = await sendWsRequest(ws, {
      id: "smoke-bootstrap",
      method: "app.bootstrap",
    });
    if (
      bootstrapResponse.ok !== true ||
      bootstrapResponse.result?.launchCwd !== appRoot ||
      typeof bootstrapResponse.result?.projectName !== "string" ||
      bootstrapResponse.result.projectName.length === 0 ||
      bootstrapResponse.result?.provider !== "codex" ||
      typeof bootstrapResponse.result?.model !== "string" ||
      bootstrapResponse.result.model.length === 0 ||
      typeof bootstrapResponse.result?.session?.sessionId !== "string" ||
      bootstrapResponse.result.session.sessionId.length === 0
    ) {
      throw new Error("Smoke test failed: app.bootstrap response payload mismatch.");
    }

    const todoTitle = `Smoke todo ${String(backendPort)}-${String(webPort)}-${Date.now()}`;
    const addedTodosResponse = await sendWsRequest(ws, {
      id: "smoke-todos-add",
      method: "todos.add",
      params: { title: todoTitle },
    });
    if (addedTodosResponse.ok !== true || !Array.isArray(addedTodosResponse.result)) {
      throw new Error("Smoke test failed: expected successful todos.add response.");
    }

    const addedTodo = addedTodosResponse.result.find((todo) => {
      return (
        typeof todo?.id === "string" &&
        todo.id.length > 0 &&
        todo.title === todoTitle &&
        todo.completed === false
      );
    });
    if (!addedTodo) {
      throw new Error("Smoke test failed: could not locate newly-added todo entry.");
    }

    const toggledTodosResponse = await sendWsRequest(ws, {
      id: "smoke-todos-toggle",
      method: "todos.toggle",
      params: addedTodo.id,
    });
    if (toggledTodosResponse.ok !== true || !Array.isArray(toggledTodosResponse.result)) {
      throw new Error("Smoke test failed: expected successful todos.toggle response.");
    }
    const toggledTodo = toggledTodosResponse.result.find((todo) => todo?.id === addedTodo.id);
    if (!toggledTodo || toggledTodo.completed !== true) {
      throw new Error("Smoke test failed: expected toggled todo to be completed.");
    }

    const removedTodosResponse = await sendWsRequest(ws, {
      id: "smoke-todos-remove",
      method: "todos.remove",
      params: addedTodo.id,
    });
    if (removedTodosResponse.ok !== true || !Array.isArray(removedTodosResponse.result)) {
      throw new Error("Smoke test failed: expected successful todos.remove response.");
    }
    if (removedTodosResponse.result.some((todo) => todo?.id === addedTodo.id)) {
      throw new Error("Smoke test failed: removed todo is still present in todos list.");
    }

    const terminalRunResponse = await sendWsRequest(ws, {
      id: "smoke-terminal-run",
      method: "terminal.run",
      params: {
        command: "echo smoke-terminal-ok",
        cwd: appRoot,
        timeoutMs: 5_000,
      },
    });
    if (
      terminalRunResponse.ok !== true ||
      typeof terminalRunResponse.result?.stdout !== "string" ||
      !terminalRunResponse.result.stdout.toLowerCase().includes("smoke-terminal-ok") ||
      terminalRunResponse.result?.stderr !== "" ||
      terminalRunResponse.result?.timedOut !== false ||
      terminalRunResponse.result?.code !== 0
    ) {
      throw new Error("Smoke test failed: terminal.run response payload mismatch.");
    }

    const duplicateTokenWhileConnectedWs = new WebSocket(
      `${parsedWsUrl.origin}${parsedWsUrl.pathname}?token=${encodeURIComponent(
        parsedWsUrl.searchParams.get("token") ?? "",
      )}&token=wrong-token`,
    );
    await waitForUnauthorizedCloseWithoutMessages(
      duplicateTokenWhileConnectedWs,
      "duplicate-token-while-connected",
    );

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Smoke test failed: post-unauthorized websocket health request timed out.")),
        20_000,
      );
      const onMessage = (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (message.type !== "response" || message.id !== "smoke-after-unauth") {
          return;
        }
        if (message.ok !== true || message.result?.status !== "ok") {
          clearTimeout(timer);
          ws.removeEventListener("message", onMessage);
          reject(new Error("Smoke test failed: expected successful post-unauthorized health response."));
          return;
        }

        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve();
      };

      ws.addEventListener("message", onMessage);
      ws.send(
        JSON.stringify({
          type: "request",
          id: "smoke-after-unauth",
          method: "app.health",
        }),
      );
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Smoke test failed: unknown-method websocket request timed out.")),
        20_000,
      );
      const onMessage = (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (message.type !== "response" || message.id !== "smoke-unknown-method") {
          return;
        }

        ws.removeEventListener("message", onMessage);
        clearTimeout(timer);

        if (
          message.ok !== false ||
          message.error?.code !== "request_failed" ||
          typeof message.error?.message !== "string" ||
          !message.error.message.includes("Unknown API method")
        ) {
          reject(
            new Error(
              `Smoke test failed: expected structured unknown-method error response, got ${JSON.stringify(
                message,
              )}.`,
            ),
          );
          return;
        }

        resolve();
      };

      ws.addEventListener("message", onMessage);
      ws.send(
        JSON.stringify({
          type: "request",
          id: "smoke-unknown-method",
          method: "unknown.method",
        }),
      );
    });

    const replacedClientClosed = waitForCloseCode(ws, 4000, "replaced-client");
    const replacementWs = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      let sawHello = false;
      let sawHealthResponse = false;
      const tryResolve = () => {
        if (!sawHello || !sawHealthResponse) {
          return;
        }
        clearTimeout(timer);
        replacementWs.removeEventListener("message", onMessage);
        resolve();
      };
      const timer = setTimeout(
        () => reject(new Error("Smoke test failed: replacement websocket did not respond in time.")),
        20_000,
      );
      const onMessage = (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (message.type === "hello") {
          if (message.version !== 1 || message.launchCwd !== appRoot) {
            clearTimeout(timer);
            replacementWs.removeEventListener("message", onMessage);
            reject(new Error("Smoke test failed: replacement websocket hello payload mismatch."));
            return;
          }
          sawHello = true;
          tryResolve();
          return;
        }

        if (message.type !== "response" || message.id !== "smoke-replacement-health") {
          return;
        }
        if (
          message.ok !== true ||
          message.result?.status !== "ok" ||
          message.result?.launchCwd !== appRoot ||
          message.result?.activeClientConnected !== true ||
          !Number.isInteger(message.result?.sessionCount) ||
          message.result.sessionCount < 0
        ) {
          clearTimeout(timer);
          replacementWs.removeEventListener("message", onMessage);
          reject(new Error("Smoke test failed: replacement websocket health payload mismatch."));
          return;
        }

        sawHealthResponse = true;
        tryResolve();
      };

      replacementWs.addEventListener("open", () => {
        replacementWs.send(
          JSON.stringify({
            type: "request",
            id: "smoke-replacement-health",
            method: "app.health",
          }),
        );
      });
      replacementWs.addEventListener("message", onMessage);
      replacementWs.addEventListener("error", () => {
        clearTimeout(timer);
        replacementWs.removeEventListener("message", onMessage);
        reject(new Error("Smoke test failed: replacement websocket client error."));
      });
    });

    await replacedClientClosed;
    replacementWs.close();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Smoke test failed."}\n`);
    process.stderr.write(output);
    process.exitCode = 1;
  } finally {
    await terminateProcess(child);
  }
}

await main();
