# Qasis

An agent that continuously QAs websites and generates reports.

> Status: installer only. Qasis does not run any QA jobs yet.

## Install

Requirements: macOS or Linux (Windows via WSL2), Node.js 22+.

```bash
git clone <this repo> qasis
cd qasis
bash qasis.sh
```

Run it directly in a terminal, not piped and not inside another agent session.
It asks for your LLM provider and API key.

```bash
bash qasis.sh --status      # show provider and whether a key is stored (masked)
bash qasis.sh --uninstall   # remove the stored key and config
```

## How the API key is handled

- **Hidden input.** The key is read in raw terminal mode. It is not echoed, and it never goes into shell history, command-line arguments or environment variables.
- **Verified before saving.** A read-only call (`GET /v1/models`) checks that the provider accepts the key.
- **Stored in the OS secret store:** macOS Keychain, or Secret Service (GNOME Keyring/KWallet) on Linux. The key is passed to these tools on stdin, so it never shows up in `ps`.
- **No `.env` with secrets.** If there is no secret store, Qasis asks before falling back to `~/.config/qasis/credentials.json`, which is readable only by you (mode `0600`, in a `0700` directory).
- **No dependencies.** The installer uses only Node built-ins, so there are no third-party packages to compromise.
- It refuses to run as root, and it creates files with `umask 077`.

Non-secret settings are kept in `~/.config/qasis/config.json`.
