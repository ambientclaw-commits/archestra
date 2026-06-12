import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# reuse the migration-kit zero-dependency client + contracts (imported by filename, not installed),
# and make the skills-eval modules importable as top-level.
sys.path.insert(0, str(ROOT / "migration-kit" / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
