export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} (see contracts/README.md)`);
  return v;
}
