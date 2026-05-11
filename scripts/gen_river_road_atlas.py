"""
Generate the river / dirt-road / roman-road atlas: one SVG per
connection bitmask (0..63), per category. The SVGs depict the full
network shape inside the hex (bends, junctions, straight channels)
rather than composing 6 directional segments.

Bitmask convention (matches HEX_DIRECTIONS in src/sim/world/hex.ts):
  bit 0 = E   (1, 0)
  bit 1 = NE  (1, -1)
  bit 2 = NW  (0, -1)
  bit 3 = W   (-1, 0)
  bit 4 = SW  (-1, 1)
  bit 5 = SE  (0, 1)

All channels reach the edge midpoint at a fixed width and color so
neighbor hexes' channels meet seamlessly regardless of which bitmask
each side happens to be.

Output files: viewer/art/<category>/c<bitmask>.svg.
"""
import math, os, pathlib

# Hex geometry in viewBox 128x148 (pointy-top).
CENTER = (64.0, 74.0)
EDGES = {
    0: (128.0, 74.0),    # E
    1: (96.0, 18.5),     # NE
    2: (32.0, 18.5),     # NW
    3: (0.0, 74.0),      # W
    4: (32.0, 129.5),    # SW
    5: (96.0, 129.5),    # SE
}
# Inward unit normal from each edge midpoint toward hex center.
def unit(p, q):
    dx, dy = q[0]-p[0], q[1]-p[1]
    n = math.hypot(dx, dy)
    return (dx/n, dy/n)
INWARD = {d: unit(EDGES[d], CENTER) for d in EDGES}

# Past-edge points (extended past hex boundary so the channel reaches
# the visible hex edge cleanly without clip-path anti-aliasing artifacts).
PAST_EDGE_EXT = 6
def past_edge(d):
    m = EDGES[d]
    n = INWARD[d]
    return (m[0] - n[0]*PAST_EDGE_EXT, m[1] - n[1]*PAST_EDGE_EXT)

# Where channels meet at the center. We use a single hub point at the hex
# center; 2-connection configs use a single curve from edge to edge,
# 3+ configs use a hub.
HUB = CENTER

def cubic_curve(start, end, t_start, t_end, depth=1.0):
    """
    Return cubic Bezier control points for a curve from `start` to `end`
    with tangent direction `t_start` at the start and `t_end` at the
    end (both unit vectors). The control-point distance scales with the
    chord length × depth.
    """
    chord = math.hypot(end[0]-start[0], end[1]-start[1])
    k = chord * 0.45 * depth
    c1 = (start[0] + t_start[0]*k, start[1] + t_start[1]*k)
    c2 = (end[0]   + t_end[0]*k,   end[1]   + t_end[1]*k)
    return c1, c2

def channel_path(edges):
    """
    Build the SVG `d` path (centerline) for a network connecting the
    given edges. For 0/1 edge counts we draw a stub; for 2 a single
    curve; for 3+ we use the hub.
    """
    n = len(edges)
    if n == 0:
        return None
    if n == 1:
        d = edges[0]
        s = past_edge(d)
        c1, c2 = cubic_curve(s, HUB, (-INWARD[d][0], -INWARD[d][1]), (INWARD[d][0], INWARD[d][1]), depth=0.6)
        return f"M {s[0]:.2f} {s[1]:.2f} C {c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {HUB[0]:.2f} {HUB[1]:.2f}"
    if n == 2:
        a, b = edges
        sa, sb = past_edge(a), past_edge(b)
        # Tangent at start points INTO the hex (along inward normal).
        ta = (-INWARD[a][0], -INWARD[a][1])  # pointing outward from edge a; but we want curve to leave A going inward
        tb = (-INWARD[b][0], -INWARD[b][1])
        # Bezier with start tangent INWARD from edge a, end tangent INWARD from edge b.
        # Both control points pull the curve toward the hex interior.
        ca = INWARD[a]
        cb = INWARD[b]
        c1, c2 = cubic_curve(sa, sb, ca, cb, depth=1.0)
        return f"M {sa[0]:.2f} {sa[1]:.2f} C {c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {sb[0]:.2f} {sb[1]:.2f}"
    # 3+: hub junction. Build one curve per edge from past-edge to hub.
    parts = []
    for d in edges:
        s = past_edge(d)
        ca = INWARD[d]
        chord = math.hypot(HUB[0]-s[0], HUB[1]-s[1])
        k = chord * 0.3
        c1 = (s[0] + ca[0]*k, s[1] + ca[1]*k)
        c2 = (HUB[0] - ca[0]*k*0.3, HUB[1] - ca[1]*k*0.3)
        parts.append(f"M {s[0]:.2f} {s[1]:.2f} C {c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {HUB[0]:.2f} {HUB[1]:.2f}")
    return " ".join(parts)

HEX_CLIP = '<clipPath id="hex"><polygon points="64,0 128,37 128,111 64,148 0,111 0,37"/></clipPath>'

def render_river(bitmask):
    edges = [d for d in range(6) if bitmask & (1<<d)]
    p = channel_path(edges)
    body = ""
    if p is not None:
        # Wide solid water channel; round-cap + round-join so junctions read
        # smoothly. Single color so adjacent channels meet seamlessly.
        body = f'<path d="{p}" fill="none" stroke="#4a86a8" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>'
        # Hub disc to cleanly cover any junction artifact.
        if len(edges) >= 3:
            body += f'<circle cx="{HUB[0]:.2f}" cy="{HUB[1]:.2f}" r="9" fill="#4a86a8"/>'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 148" preserveAspectRatio="xMidYMid meet">
  <defs>{HEX_CLIP}</defs>
  <g clip-path="url(#hex)">{body}</g>
</svg>
'''

def render_dirt(bitmask):
    edges = [d for d in range(6) if bitmask & (1<<d)]
    p = channel_path(edges)
    body = ""
    if p is not None:
        # Two-stroke dirt road: dark wide outer, lighter narrow center.
        body = (
            f'<path d="{p}" fill="none" stroke="#7a5a30" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<path d="{p}" fill="none" stroke="#a07a3e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>'
            f'<path d="{p}" fill="none" stroke="#5a4022" stroke-width="0.5" opacity="0.55"/>'
        )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 148" preserveAspectRatio="xMidYMid meet">
  <defs>{HEX_CLIP}</defs>
  <g clip-path="url(#hex)">{body}</g>
</svg>
'''

def render_roman(bitmask):
    edges = [d for d in range(6) if bitmask & (1<<d)]
    p = channel_path(edges)
    body = ""
    if p is not None:
        # Wide pale-stone road with darker curb lines parallel-stroked.
        body = (
            f'<path d="{p}" fill="none" stroke="#3a342a" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<path d="{p}" fill="none" stroke="#a89868" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<path d="{p}" fill="none" stroke="#5a4e36" stroke-width="0.6" stroke-linecap="round" opacity="0.55"/>'
        )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 148" preserveAspectRatio="xMidYMid meet">
  <defs>{HEX_CLIP}</defs>
  <g clip-path="url(#hex)">{body}</g>
</svg>
'''

ROOT = pathlib.Path("viewer/art")
for cat, renderer in [
    ("rivers", render_river),
    ("roads/dirt", render_dirt),
    ("roads/roman", render_roman),
]:
    out_dir = ROOT / cat
    out_dir.mkdir(parents=True, exist_ok=True)
    for bm in range(64):
        (out_dir / f"c{bm}.svg").write_text(renderer(bm))
    # Remove old per-direction segment files now that the atlas exists.
    for old in ("e", "ne", "nw", "w", "sw", "se"):
        f = out_dir / f"{old}.svg"
        if f.exists():
            f.unlink()
print("done")
