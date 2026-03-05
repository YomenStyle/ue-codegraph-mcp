/**
 * UE naming convention utilities.
 * A* = AActor subclass
 * U* = UObject subclass
 * F* = Struct / plain C++ class
 * E* = Enum
 * I* = Interface
 * T* = Template
 */

export type UEPrefix = 'A' | 'U' | 'F' | 'E' | 'I' | 'T' | 'S' | 'None';

export function getUEPrefix(name: string): UEPrefix {
  if (!name || name.length < 2) return 'None';

  const second = name[1];
  if (second !== second.toUpperCase() || second === second.toLowerCase()) {
    return 'None'; // Second char must be uppercase
  }

  const first = name[0];
  switch (first) {
    case 'A': return 'A';
    case 'U': return 'U';
    case 'F': return 'F';
    case 'E': return 'E';
    case 'I': return 'I';
    case 'T': return 'T';
    case 'S': return 'S'; // Slate widgets
    default: return 'None';
  }
}

export function getUETypeDescription(prefix: UEPrefix): string {
  switch (prefix) {
    case 'A': return 'Actor subclass';
    case 'U': return 'UObject subclass';
    case 'F': return 'Struct or plain C++ class';
    case 'E': return 'Enum type';
    case 'I': return 'Interface';
    case 'T': return 'Template type';
    case 'S': return 'Slate widget';
    case 'None': return 'No UE prefix';
  }
}

export function stripUEPrefix(name: string): string {
  const prefix = getUEPrefix(name);
  if (prefix === 'None') return name;
  return name.substring(1);
}

export function isUEType(name: string): boolean {
  return getUEPrefix(name) !== 'None';
}
