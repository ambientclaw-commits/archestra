"""Offline tests for the lifecycle pure helpers (env parse, db naming, url rewrite, env assembly).

The live boot (create db / migrate / spawn backend) is a true process boundary exercised manually."""

from pathlib import Path

from lifecycle import benchmark_db_name, build_backend_env, libpq_url, parse_env_file, with_dbname


def test_parse_env_file_strips_quotes_and_skips_comments(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# a comment\n"
        'ARCHESTRA_DATABASE_URL="postgresql://u:p@localhost:5432/archestra_dev?schema=public"\n'
        "\n"
        "ARCHESTRA_AUTH_ADMIN_EMAIL=admin@example.com\n"
        "EMPTY=\n",
        encoding="utf-8",
    )
    env = parse_env_file(env_file)
    assert env["ARCHESTRA_DATABASE_URL"] == "postgresql://u:p@localhost:5432/archestra_dev?schema=public"
    assert env["ARCHESTRA_AUTH_ADMIN_EMAIL"] == "admin@example.com"
    assert env["EMPTY"] == ""
    assert "# a comment" not in env


def test_benchmark_db_name_is_postgres_safe() -> None:
    assert benchmark_db_name("20260612T120000Z") == "archestra_bench_20260612t120000z"
    assert benchmark_db_name("feat/skills-eval") == "archestra_bench_feat_skills_eval"
    assert benchmark_db_name("") == "archestra_bench_run"


def test_with_dbname_preserves_query() -> None:
    url = "postgresql://u:p@localhost:5432/archestra_dev?schema=public"
    assert with_dbname(url, "archestra_bench_x") == "postgresql://u:p@localhost:5432/archestra_bench_x?schema=public"


def test_libpq_url_drops_non_libpq_query() -> None:
    assert (
        libpq_url("postgresql://u:secret@db.local:6543/archestra_dev?schema=public")
        == "postgresql://u:secret@db.local:6543/archestra_dev"
    )


def test_build_backend_env_layers_overrides_last() -> None:
    base = {"ARCHESTRA_DATABASE_URL": "postgresql://u:p@localhost:5432/archestra_dev", "ARCHESTRA_AUTH_SECRET": "s"}
    env = build_backend_env(
        base_env=base,
        db_url="postgresql://u:p@localhost:5432/archestra_bench_x?schema=public",
        api_base_url="http://localhost:9123",
        metrics_port=9124,
        dagger_cli_bin="/repo/platform/dev/bin/dagger",
    )
    assert env["ARCHESTRA_DATABASE_URL"] == "postgresql://u:p@localhost:5432/archestra_bench_x?schema=public"
    assert env["ARCHESTRA_INTERNAL_API_BASE_URL"] == "http://localhost:9123"
    assert env["ARCHESTRA_METRICS_PORT"] == "9124"
    assert env["ARCHESTRA_CODE_RUNTIME_ENABLED"] == "true"
    assert env["ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST"] == "tcp://127.0.0.1:1234"
    assert env["ARCHESTRA_AUTH_SECRET"] == "s"  # preserved from base, not overridden
