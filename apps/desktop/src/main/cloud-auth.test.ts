import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudAuthManager,
  normalizeCloudBaseUrl,
  resolveCloudBaseUrl,
} from "./cloud-auth";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

async function setup(
  allowInsecureLocalDevelopment = false,
  revokeTimeoutMs?: number,
) {
  const storageDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zennotes-cloud-auth-"),
  );
  temporaryDirectories.push(storageDirectory);
  const secrets = new Map<string, string>();
  const openExternal = vi.fn(async () => {});
  const fetchImplementation = vi.fn<typeof fetch>();
  const manager = new CloudAuthManager({
    storageDirectory,
    appVersion: "2.26.0",
    deviceName: "Test Mac",
    openExternal,
    fetchImplementation,
    getSecret: async (baseUrl) => secrets.get(baseUrl) ?? null,
    setSecret: async (baseUrl, token) => {
      secrets.set(baseUrl, token);
      return true;
    },
    deleteSecret: async (baseUrl) => {
      secrets.delete(baseUrl);
    },
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    randomState: () => "fixed-state",
    randomVerifier: () => "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    allowInsecureLocalDevelopment,
    revokeTimeoutMs,
  });
  return {
    manager,
    storageDirectory,
    secrets,
    openExternal,
    fetchImplementation,
  };
}

describe("CloudAuthManager", () => {
  it("starts browser authorization without exposing a credential", async () => {
    const { manager, storageDirectory, openExternal } = await setup();

    await expect(manager.connect("https://zennotes.org/")).resolves.toEqual({
      authorization_url:
        "https://zennotes.org/app/connect?state=fixed-state&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256",
      expires_at: "2026-08-10T12:05:00.000Z",
    });
    expect(openExternal).toHaveBeenCalledWith(
      "https://zennotes.org/app/connect?state=fixed-state&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256",
    );
    expect(await manager.status()).toEqual({
      state: "connecting",
      account: null,
    });
    expect(
      await readFile(
        path.join(storageDirectory, "cloud-auth-pending.json"),
        "utf8",
      ),
    ).not.toContain("token");
  });

  it("binds an unpackaged development request to its loopback callback", async () => {
    const { manager, openExternal } = await setup(true);
    const callbackUrl = "http://127.0.0.1:49152/auth/callback";

    await expect(
      manager.connect("http://zennotes.test", callbackUrl),
    ).resolves.toEqual({
      authorization_url:
        "http://zennotes.test/app/connect?state=fixed-state&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&callback_url=http%3A%2F%2F127.0.0.1%3A49152%2Fauth%2Fcallback",
      expires_at: "2026-08-10T12:05:00.000Z",
    });
    expect(openExternal).toHaveBeenCalledWith(
      "http://zennotes.test/app/connect?state=fixed-state&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&callback_url=http%3A%2F%2F127.0.0.1%3A49152%2Fauth%2Fcallback",
    );
  });

  it("exchanges the bound callback and stores only account metadata on disk", async () => {
    const { manager, storageDirectory, secrets, fetchImplementation } =
      await setup();
    await manager.connect("https://zennotes.org");
    fetchImplementation.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: "secret-token",
          user: { name: "Ada", email: "ada@example.com" },
          device: { id: "device-1", name: "Test Mac", platform: "desktop" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const status = await manager.complete({
      code: "OneTimeCode",
      state: "fixed-state",
    });

    expect(status.state).toBe("connected");
    expect(secrets.get("https://zennotes.org")).toBe("secret-token");
    const metadata = await readFile(
      path.join(storageDirectory, "cloud-account.json"),
      "utf8",
    );
    expect(metadata).toContain("ada@example.com");
    expect(metadata).not.toContain("secret-token");
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://zennotes.org/api/v1/app/exchange",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          code: "OneTimeCode",
          state: "fixed-state",
          code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
          device_name: "Test Mac",
          platform: "desktop",
          app_version: "2.26.0",
        }),
      }),
    );
  });

  it("rejects callbacks that do not match the pending state", async () => {
    const { manager, fetchImplementation } = await setup();
    await manager.connect("https://zennotes.org");

    await expect(
      manager.complete({ code: "OneTimeCode", state: "other-state" }),
    ).rejects.toThrow("invalid or has expired");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("clears pending authorization when the browser cannot open", async () => {
    const { manager, openExternal, storageDirectory } = await setup();
    openExternal.mockRejectedValueOnce(new Error("unavailable"));

    await expect(manager.connect("https://zennotes.org")).rejects.toThrow(
      "unavailable",
    );
    await expect(manager.status()).resolves.toEqual({
      state: "disconnected",
      account: null,
    });
    await expect(
      readFile(path.join(storageDirectory, "cloud-auth-pending.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("removes the stored credential when logging out", async () => {
    const { manager, secrets, fetchImplementation } = await setup();
    await connectAccount(manager, fetchImplementation);
    fetchImplementation.mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );

    await expect(manager.logout()).resolves.toEqual({
      state: "disconnected",
      account: null,
    });
    expect(secrets.size).toBe(0);
  });

  it("fails closed when persisted auth metadata is malformed", async () => {
    const { manager, storageDirectory } = await setup();
    await writeFile(
      path.join(storageDirectory, "cloud-account.json"),
      '{"base_url":42}',
    );
    await writeFile(
      path.join(storageDirectory, "cloud-auth-pending.json"),
      '{"state":42}',
    );

    await expect(manager.status()).resolves.toEqual({
      state: "disconnected",
      account: null,
    });
    await expect(
      manager.complete({ code: "OneTimeCode", state: "fixed-state" }),
    ).rejects.toThrow("invalid or has expired");
  });
});

async function connectAccount(
  manager: CloudAuthManager,
  fetchImplementation: ReturnType<typeof vi.fn<typeof fetch>>,
): Promise<void> {
  await manager.connect("https://zennotes.org");
  fetchImplementation.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        token: "secret-token",
        user: { name: "Ada", email: "ada@example.com" },
        device: { id: "device-1", name: "Test Mac", platform: "desktop" },
      }),
      { status: 200 },
    ),
  );
  await manager.complete({ code: "OneTimeCode", state: "fixed-state" });
  fetchImplementation.mockClear();
}

describe("CloudAuthManager logout revokes the device", () => {
  it("asks the service with the token before deleting it", async () => {
    const { manager, secrets, fetchImplementation, storageDirectory } =
      await setup();
    await connectAccount(manager, fetchImplementation);
    let tokenWhileRevoking: string | undefined;
    fetchImplementation.mockImplementationOnce(async () => {
      tokenWhileRevoking = secrets.get("https://zennotes.org");
      return new Response(null, { status: 204 });
    });

    await expect(manager.logout()).resolves.toEqual({
      state: "disconnected",
      account: null,
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0];
    expect(url).toBe("https://zennotes.org/api/v1/devices/current");
    expect(init).toMatchObject({
      method: "DELETE",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer secret-token",
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(tokenWhileRevoking).toBe("secret-token");
    expect(secrets.size).toBe(0);
    await expect(
      readFile(path.join(storageDirectory, "cloud-account.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("signs out when the service fails or cannot be reached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const answer of [
        () => Promise.reject(new TypeError("fetch failed")),
        () => Promise.resolve(new Response(null, { status: 500 })),
      ]) {
        const { manager, secrets, fetchImplementation } = await setup();
        await connectAccount(manager, fetchImplementation);
        fetchImplementation.mockImplementationOnce(answer);

        await expect(manager.logout()).resolves.toEqual({
          state: "disconnected",
          account: null,
        });
        expect(secrets.size).toBe(0);
      }
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("stops waiting for a service that never answers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { manager, secrets, fetchImplementation } = await setup(false, 20);
      await connectAccount(manager, fetchImplementation);
      fetchImplementation.mockImplementationOnce(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      );

      await expect(manager.logout()).resolves.toEqual({
        state: "disconnected",
        account: null,
      });
      expect(secrets.size).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("takes an already revoked token (401) as done", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { manager, secrets, fetchImplementation } = await setup();
      await connectAccount(manager, fetchImplementation);
      fetchImplementation.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Unauthenticated." }), {
          status: 401,
        }),
      );

      await manager.logout();

      expect(secrets.size).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("asks zennotes.org for a legacy account and skips an account with no token", async () => {
    const { manager, storageDirectory, secrets, fetchImplementation } =
      await setup();
    const legacyAccount = {
      base_url: "https://zennotes.laravel.cloud",
      user: { name: "Niri", email: "niri@example.com" },
      device: { id: "device-3", name: "Test Mac", platform: "desktop" },
      connected_at: "2026-08-12T09:00:00.000Z",
    };
    await writeFile(
      path.join(storageDirectory, "cloud-account.json"),
      JSON.stringify(legacyAccount),
    );
    secrets.set("https://zennotes.laravel.cloud", "legacy-token");
    fetchImplementation.mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );

    await manager.logout();

    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation.mock.calls[0][0]).toBe(
      "https://zennotes.org/api/v1/devices/current",
    );
    expect(fetchImplementation.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer legacy-token",
    });
    expect(secrets.size).toBe(0);

    fetchImplementation.mockClear();
    await writeFile(
      path.join(storageDirectory, "cloud-account.json"),
      JSON.stringify({ ...legacyAccount, base_url: "https://zennotes.org" }),
    );

    await manager.logout();

    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe("normalizeCloudBaseUrl", () => {
  it("requires a clean HTTPS origin", () => {
    expect(normalizeCloudBaseUrl("https://zennotes.org/")).toBe(
      "https://zennotes.org",
    );
    expect(() => normalizeCloudBaseUrl("http://zennotes.org")).toThrow("HTTPS");
    expect(() => normalizeCloudBaseUrl("https://zennotes.org/app")).toThrow(
      "without a path",
    );
    expect(normalizeCloudBaseUrl("http://localhost:8000", true)).toBe(
      "http://localhost:8000",
    );
  });

  it("allows a reserved test domain only for local development", () => {
    expect(normalizeCloudBaseUrl("http://zennotes.test", true)).toBe(
      "http://zennotes.test",
    );
    expect(() => normalizeCloudBaseUrl("http://zennotes.test")).toThrow(
      "HTTPS",
    );
  });
});

describe("resolveCloudBaseUrl", () => {
  it("uses the production cloud service by default in development", () => {
    expect(resolveCloudBaseUrl(undefined, false)).toBe("https://zennotes.org");
  });

  it("supports an explicit development override", () => {
    expect(resolveCloudBaseUrl(undefined, false, "http://localhost:8000")).toBe(
      "http://localhost:8000",
    );
    expect(resolveCloudBaseUrl("http://127.0.0.1:8000", false)).toBe(
      "http://127.0.0.1:8000",
    );
  });

  it("keeps packaged builds pinned to the configured cloud service", () => {
    expect(
      resolveCloudBaseUrl(
        "http://zennotes.test",
        true,
        "http://localhost:8000",
      ),
    ).toBe("https://zennotes.org");
  });
});

describe("legacy Laravel Cloud account migration (2.28.0 → 2.28.1)", () => {
  const legacyAccount = {
    base_url: "https://zennotes.laravel.cloud",
    user: { id: 7, name: "Niri", email: "niri@example.com" },
    device: { id: "device-3", name: "Test Mac", platform: "desktop" },
    connected_at: "2026-08-12T09:00:00.000Z",
  };

  it("re-keys the stored account and credential to zennotes.org on read", async () => {
    const { manager, storageDirectory, secrets } = await setup();
    await writeFile(
      path.join(storageDirectory, "cloud-account.json"),
      JSON.stringify(legacyAccount),
    );
    secrets.set("https://zennotes.laravel.cloud", "legacy-token");

    const status = await manager.status();

    expect(status.state).toBe("connected");
    expect(status.account?.base_url).toBe("https://zennotes.org");
    expect(status.account?.user).toEqual(legacyAccount.user);
    expect(secrets.get("https://zennotes.org")).toBe("legacy-token");
    expect(secrets.has("https://zennotes.laravel.cloud")).toBe(false);
    const persisted = JSON.parse(
      await readFile(
        path.join(storageDirectory, "cloud-account.json"),
        "utf8",
      ),
    );
    expect(persisted.base_url).toBe("https://zennotes.org");
  });

  it("reports disconnected without rewriting when the legacy credential is gone", async () => {
    const { manager, storageDirectory, secrets } = await setup();
    await writeFile(
      path.join(storageDirectory, "cloud-account.json"),
      JSON.stringify(legacyAccount),
    );

    const status = await manager.status();

    expect(status.state).toBe("disconnected");
    expect(secrets.size).toBe(0);
    const persisted = JSON.parse(
      await readFile(
        path.join(storageDirectory, "cloud-account.json"),
        "utf8",
      ),
    );
    expect(persisted.base_url).toBe("https://zennotes.laravel.cloud");
  });

  it("keeps the legacy pairing intact when the new credential cannot be stored", async () => {
    const { manager, storageDirectory, secrets } = await setup();
    await writeFile(
      path.join(storageDirectory, "cloud-account.json"),
      JSON.stringify(legacyAccount),
    );
    secrets.set("https://zennotes.laravel.cloud", "legacy-token");
    const failingManager = manager as unknown as {
      dependencies: { setSecret(baseUrl: string, token: string): Promise<boolean> };
    };
    failingManager.dependencies.setSecret = async () => false;

    const status = await manager.status();

    expect(status.state).toBe("connected");
    expect(status.account?.base_url).toBe("https://zennotes.laravel.cloud");
    expect(secrets.get("https://zennotes.laravel.cloud")).toBe("legacy-token");
  });
});
