# Rollback

A rollback is a re-pin: put the previous digest back in the folder's `image` file and let `deploy.yml` deploy it.

1. Find the previous pin:

   ```sh
   git log -p --follow servers/<folder>/image
   ```

2. In a pull request, write the previous line back into `servers/<folder>/image`. For a production folder the previous digest is already in `passed-on-staging.txt` (it was pinned there before, so it passed), and `check-pins.ts` accepts it. Merge: `deploy.yml` deploys it and runs `post-deploy-check.sh`.
3. Roll back staging and production separately: a production rollback leaves staging as it is, so the newer build can be looked at there.

**The database only moves forward.** The server applies new migrations at start and never undoes them, so an older image starts on a newer schema. Whether an older build runs on a newer schema is not guaranteed. If it does not start (`fly logs --app <app>` shows `start_failed`), the way back is to restore that app's Supabase project from a backup taken before the upgrade (the project's Database → Backups page; what is kept depends on the plan), which loses everything since. Each app has its own project, so a restore touches only that app. If the restore changes the connection details, set the app's `DATABASE_URL` again (`secrets.md`) and redeploy. Back up before you upgrade production.

**Only if GitHub Actions is down**, deploy the previous pin by hand from a checkout of `main` with the old line restored, then make the repo match with a pull request at once:

```sh
f=<folder>; app=<app>; mode=<production|test>
env_args=(); while IFS= read -r l; do case "$l" in ''|'#'*) ;; *) env_args+=(--env "$l");; esac; done < "servers/$f/server.env"
(cd "servers/$f" && fly deploy --app "$app" --config fly.toml --image "$(cat image)" --ha=false "${env_args[@]}")
scripts/post-deploy-check.sh "https://$app.fly.dev" "$mode"
```

Run it in bash 4 or later. Never deploy to production by hand a digest that is not in `passed-on-staging.txt`; run `node --experimental-strip-types scripts/check-pins.ts .` first.
