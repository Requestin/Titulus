#!/usr/bin/env python3
"""Plan disjoint, SMT-aware CPU masks for Titulus render channels."""

from __future__ import annotations

import argparse
import collections
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Core:
    key: tuple[int, int, int]
    cpus: tuple[int, ...]
    l3: str


def read_host_topology() -> dict[str, Any]:
    output = subprocess.check_output(
        ["lscpu", "-p=CPU,CORE,SOCKET,NODE"], text=True, encoding="utf-8"
    )
    cpus: list[dict[str, int]] = []
    for line in output.splitlines():
        if not line or line.startswith("#"):
            continue
        cpu, core, socket, node = (int(part) for part in line.split(","))
        cpus.append({"cpu": cpu, "core": core, "socket": socket, "node": node})

    domains: list[dict[str, list[int]]] = []
    seen: set[str] = set()
    for row in cpus:
        path = Path(
            f"/sys/devices/system/cpu/cpu{row['cpu']}/cache/index3/shared_cpu_list"
        )
        if not path.exists():
            continue
        value = path.read_text(encoding="utf-8").strip()
        if value in seen:
            continue
        seen.add(value)
        domains.append({"cpus": parse_cpu_list(value)})
    return {"cpus": cpus, "l3_domains": domains}


def parse_cpu_list(spec: str) -> list[int]:
    cpus: list[int] = []
    for item in spec.split(","):
        if "-" in item:
            start, end = (int(value) for value in item.split("-", maxsplit=1))
            cpus.extend(range(start, end + 1))
        elif item:
            cpus.append(int(item))
    return cpus


def make_cores(topology: dict[str, Any]) -> list[Core]:
    core_cpus: dict[tuple[int, int, int], list[int]] = collections.defaultdict(list)
    for row in topology["cpus"]:
        key = (int(row["node"]), int(row["socket"]), int(row["core"]))
        core_cpus[key].append(int(row["cpu"]))

    l3_by_cpu: dict[int, str] = {}
    for index, domain in enumerate(topology.get("l3_domains", [])):
        label = f"l3-{index}"
        for cpu in domain["cpus"]:
            l3_by_cpu[int(cpu)] = label

    cores: list[Core] = []
    for key in sorted(core_cpus):
        cpus = tuple(sorted(core_cpus[key]))
        labels = {l3_by_cpu.get(cpu, "unknown") for cpu in cpus}
        l3 = next(iter(labels)) if len(labels) == 1 else "mixed"
        cores.append(Core(key=key, cpus=cpus, l3=l3))
    return cores


def choose_ccx(available: list[Core], count: int) -> list[Core]:
    by_l3: dict[str, list[Core]] = collections.defaultdict(list)
    for core in available:
        by_l3[core.l3].append(core)
    local_domains = [
        cores for _, cores in sorted(by_l3.items()) if len(cores) >= count
    ]
    if local_domains:
        return min(local_domains, key=lambda cores: cores[0].key)[:count]
    return available[:count]


def plan(
    topology: dict[str, Any],
    channels: int,
    cores_per_channel: int,
    house_cores: int,
    pack: str,
) -> dict[str, Any]:
    cores = make_cores(topology)
    if channels <= 0 or cores_per_channel <= 0 or house_cores < 0:
        raise ValueError("channels, cores-per-channel and house-cores must be valid")
    if house_cores + channels * cores_per_channel > len(cores):
        raise ValueError(
            "capacity shortfall: "
            f"{len(cores)} physical cores cannot satisfy "
            f"{house_cores} house + {channels} x {cores_per_channel} channel cores"
        )

    house = cores[:house_cores]
    available = cores[house_cores:]
    assignments: list[list[Core]] = []
    for _ in range(channels):
        picked = (
            available[:cores_per_channel]
            if pack == "sequential"
            else choose_ccx(available, cores_per_channel)
        )
        assignments.append(picked)
        picked_keys = {core.key for core in picked}
        available = [core for core in available if core.key not in picked_keys]

    allocated: list[int] = []
    channel_data: list[dict[str, Any]] = []
    for index, assigned in enumerate(assignments):
        cpus = [cpu for core in assigned for cpu in core.cpus]
        allocated.extend(cpus)
        l3 = [core.l3 for core in assigned]
        channel_data.append(
            {
                "index": index,
                "phys": [core.key[2] for core in assigned],
                "cpus": ",".join(str(cpu) for cpu in cpus),
                "l3_domains": l3,
                "quality": "local" if len(set(l3)) == 1 else "straddle",
                "raster_threads": max(1, len(cpus) - 1),
            }
        )
    return {
        "phys_cores": len(cores),
        "logical_cpus": sum(len(core.cpus) for core in cores),
        "house": [cpu for core in house for cpu in core.cpus],
        "pack": pack,
        "channels": channel_data,
        "overlap": len(allocated) != len(set(allocated)),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channels", type=int, required=True)
    parser.add_argument("--cores-per-channel", type=int, default=2)
    parser.add_argument("--house-cores", type=int, default=0)
    parser.add_argument("--pack", choices=("sequential", "ccx"), default="sequential")
    parser.add_argument("--topology-fixture", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        topology = (
            json.loads(args.topology_fixture.read_text(encoding="utf-8"))
            if args.topology_fixture
            else read_host_topology()
        )
        result = plan(
            topology,
            args.channels,
            args.cores_per_channel,
            args.house_cores,
            args.pack,
        )
    except (OSError, ValueError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(f"detect-cpu-pack: {error}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(
            f"pack={result['pack']} physical={result['phys_cores']} "
            f"logical={result['logical_cpus']} house={result['house']}"
        )
        for channel in result["channels"]:
            print(
                f"channel={channel['index']} cpus={channel['cpus']} "
                f"quality={channel['quality']} raster_threads={channel['raster_threads']}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
