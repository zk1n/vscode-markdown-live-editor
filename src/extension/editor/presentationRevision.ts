let nextRevision = 1;

/** Monotonic for the lifetime of this Extension Host process. */
export function allocatePresentationRevision(): number {
  const revision = nextRevision;
  nextRevision += 1;
  return revision;
}
