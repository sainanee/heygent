# Invites

People get accounts with a one-time sign-up code, issued with the server's operator CLI inside the running machine. Each code works once, for 7 days. Production refuses `person:add` (an account with no passkey); use `invite:signup`.

These steps follow Parley's operator guide, section 6 and section 9 step 6. Fly's handling of the quoting in `-C` commands is not confirmed: if a command misbehaves, use the fallback below.

**1. Check the SSH session has the app's settings.** The single quotes keep your own shell from expanding the variables:

```sh
fly ssh console --app <app> -C 'sh -c "test -n \"$PARLEY_DOMAIN\" && test -n \"$PARLEY_SECRET_KEY\" && test -n \"$DATABASE_URL\" && echo env-ok"'
```

It must print `env-ok` (a partial check: three settings).

**2. Issue a code:**

```sh
fly ssh console --app <app> -C "node --experimental-strip-types --disable-warning=ExperimentalWarning /app/apps/server/src/agent/cli.ts invite:signup"
```

It prints one code, once. Give it to the person over a private channel; never paste it into an issue or a chat with an agent. They open `https://<app>.fly.dev/signup`, enter the code, choose their handle and time zone, and create a passkey. Their address is `<handle>@<app>.fly.dev`; their console is `https://<app>.fly.dev/console`.

**Fallback** (unverified): if step 1 does not print `env-ok`, or step 2 prints `failed: Error`, open an interactive shell with `fly ssh console --app <app>` and run the CLI command there, or try `fly machine exec <machine-id> "<command>" --app <app>`. Inside the interactive shell, `printenv | cut -d= -f1 | grep PARLEY` lists the settings it has, without values. `failed: Error` can also mean a wrong setting: check it as the operator guide's "Reading a failed start" says.

Commands that ask for hidden input (`routine-webhook`) need a terminal: add `--pty` to `fly ssh console`. Run the CLI with no arguments to list its commands.

**On staging** the CLI uses the server's stored test clock, which conformance moves about 8 days forward on every run (`deploy.md`). A code issued on staging therefore expires at the next conformance run.
