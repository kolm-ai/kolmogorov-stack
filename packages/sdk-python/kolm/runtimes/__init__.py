"""Runtime adapters for kolm SDK.

Each adapter exposes one symbol; the parent package late-imports it only
when the matching runtime library is installed. Keep modules cheap to
import — no top-level heavy imports.
"""
