# Pi Follow-up Priority

Durable, dynamically prioritized follow-up handling for Pi.

## Behavior

- Steering messages rank newest-first.
- Ordinary follow-ups remain FIFO.
- New input changes priority without cancelling unfinished input.
- Each item receives a durable identity and stays independent from unrelated text or attachments.
- Multi-item or multi-step work receives provider-only Todo guidance.
- Only an explicit per-ID completion receipt retires an item.
- Reload, context pruning, branch navigation, aborts, errors, and tool-use progress do not silently complete pending work.

## Install

```bash
pi install git:github.com/YukiRa1n/pi-follow-up-priority
```

Reload Pi:

```text
/reload
```

For a project-local installation:

```bash
pi install -l git:github.com/YukiRa1n/pi-follow-up-priority
```

To remove it:

```bash
pi remove git:github.com/YukiRa1n/pi-follow-up-priority
```

## Pi 0.84.x and 0.85.x compaction compatibility

These Pi versions can lose or duplicate input queued during compaction rollback before extension hooks run. Clone this repository, install its development dependencies, inspect the global Pi host, and apply the bounded compatibility patch:

```bash
npm install
npm run check:pi-compaction
npm run patch:pi-compaction
```

The patch validates the Pi package, supported version, prompt-preflight API, vulnerable method shape, and bundled target count. It keeps adjacent `.compaction-queue-original*` backups, is idempotent, and refuses unknown host shapes. Fully restart Pi after applying it. Recheck after each Pi upgrade.

## Verification

```bash
npm install
npm test
npm pack --dry-run
```

See [the follow-up priority lifecycle](docs/follow-up-priority-lifecycle.md) for the persistence and completion contract.

## License

MIT
