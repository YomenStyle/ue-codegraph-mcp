import Parser from 'tree-sitter';

export interface ExtractedSymbol {
  name: string;
  qualifiedName: string | null;
  kind: string;
  access: string | null;
  isStatic: boolean;
  isVirtual: boolean;
  isConst: boolean;
  isInline: boolean;
  returnType: string | null;
  lineStart: number;
  lineEnd: number;
  columnStart: number;
  signature: string | null;
  rawText: string | null;
  parentName: string | null;  // for nesting
  parameters: ExtractedParameter[];
  baseClasses: ExtractedBaseClass[];
  children: ExtractedSymbol[];
}

export interface ExtractedParameter {
  name: string | null;
  type: string;
  defaultValue: string | null;
  position: number;
}

export interface ExtractedBaseClass {
  name: string;
  access: string;
  isVirtual: boolean;
}

export function extractSymbols(tree: Parser.Tree, source: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const root = tree.rootNode;

  for (const child of root.children) {
    extractFromNode(child, source, symbols, null, null);
  }

  return symbols;
}

function extractFromNode(
  node: Parser.SyntaxNode,
  source: string,
  symbols: ExtractedSymbol[],
  parentName: string | null,
  currentAccess: string | null,
): void {
  switch (node.type) {
    case 'class_specifier':
    case 'struct_specifier':
      extractClassOrStruct(node, source, symbols, parentName);
      break;
    case 'enum_specifier':
      extractEnum(node, source, symbols, parentName);
      break;
    case 'function_definition':
      extractFunction(node, source, symbols, parentName, currentAccess, false);
      break;
    case 'declaration':
    case 'field_declaration':
      extractDeclaration(node, source, symbols, parentName, currentAccess);
      break;
    case 'template_declaration':
      extractTemplate(node, source, symbols, parentName, currentAccess);
      break;
    case 'namespace_definition':
      extractNamespace(node, source, symbols, parentName);
      break;
    case 'type_definition':
      extractTypedef(node, source, symbols, parentName);
      break;
    case 'preproc_def':
    case 'preproc_function_def':
      extractMacroDefinition(node, source, symbols, parentName);
      break;
  }
}

function extractClassOrStruct(
  node: Parser.SyntaxNode,
  source: string,
  symbols: ExtractedSymbol[],
  parentName: string | null,
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nameNode.text;
  const kind = node.type === 'class_specifier' ? 'class' : 'struct';

  const baseClasses = extractBaseClasses(node);
  const children: ExtractedSymbol[] = [];

  // Extract members from body
  const body = node.childForFieldName('body');
  if (body) {
    let access = kind === 'class' ? 'private' : 'public';
    for (const member of body.children) {
      if (member.type === 'access_specifier') {
        access = member.text.replace(':', '').trim();
      } else {
        extractFromNode(member, source, children, name, access);
      }
    }
  }

  const qualifiedName = parentName ? `${parentName}::${name}` : name;

  symbols.push({
    name,
    qualifiedName,
    kind,
    access: null,
    isStatic: false,
    isVirtual: false,
    isConst: false,
    isInline: false,
    returnType: null,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    columnStart: node.startPosition.column,
    signature: null,
    rawText: truncateText(node.text, 500),
    parentName,
    parameters: [],
    baseClasses,
    children,
  });
}

function extractBaseClasses(node: Parser.SyntaxNode): ExtractedBaseClass[] {
  const bases: ExtractedBaseClass[] = [];
  const baseList = node.children.find(c => c.type === 'base_class_clause');
  if (!baseList) return bases;

  for (const child of baseList.children) {
    if (child.type === 'base_class_specifier' || child.type === 'type_identifier' || child.type === 'qualified_identifier') {
      // Parse access specifier and class name from base_class_specifier
      let access = 'public';
      let name = '';
      let isVirtual = false;

      if (child.type === 'base_class_specifier') {
        for (const part of child.children) {
          if (part.text === 'public' || part.text === 'protected' || part.text === 'private') {
            access = part.text;
          } else if (part.text === 'virtual') {
            isVirtual = true;
          } else if (part.type === 'type_identifier' || part.type === 'qualified_identifier' || part.type === 'template_type') {
            name = part.text;
          }
        }
      } else {
        name = child.text;
      }

      if (name) {
        bases.push({ name, access, isVirtual });
      }
    }
  }
  return bases;
}

function extractFunction(
  node: Parser.SyntaxNode,
  source: string,
  symbols: ExtractedSymbol[],
  parentName: string | null,
  access: string | null,
  isDeclaration: boolean,
): void {
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return;

  const { name, qualifiedParent } = extractFunctionName(declarator);
  if (!name) return;

  const isStatic = hasStorageSpecifier(node, 'static');
  const isVirtual = hasSpecifier(node, 'virtual');
  const isConst = declarator.text.includes(') const');
  const isInline = hasStorageSpecifier(node, 'inline');
  const returnType = extractReturnType(node);
  const parameters = extractParameters(declarator);

  const effectiveParent = qualifiedParent || parentName;
  const qualifiedName = effectiveParent ? `${effectiveParent}::${name}` : name;

  let kind: string;
  if (name === parentName || name === effectiveParent?.split('::').pop()) {
    kind = 'constructor';
  } else if (name.startsWith('~')) {
    kind = 'destructor';
  } else if (effectiveParent) {
    kind = 'method';
  } else {
    kind = 'function';
  }

  const sig = buildSignature(returnType, name, parameters, isConst);

  symbols.push({
    name,
    qualifiedName,
    kind,
    access,
    isStatic,
    isVirtual,
    isConst,
    isInline,
    returnType,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    columnStart: node.startPosition.column,
    signature: sig,
    rawText: truncateText(node.text, 500),
    parentName: effectiveParent,
    parameters,
    baseClasses: [],
    children: [],
  });
}

function extractDeclaration(
  node: Parser.SyntaxNode,
  source: string,
  symbols: ExtractedSymbol[],
  parentName: string | null,
  access: string | null,
): void {
  // Check for function declarations
  for (const child of node.children) {
    if (child.type === 'function_declarator') {
      extractFunction(node, source, symbols, parentName, access, true);
      return;
    }
    // Handle pointer/reference return types: e.g. virtual UObject* GetObject() override;
    if (child.type === 'pointer_declarator' || child.type === 'reference_declarator') {
      if (findDeepChild(child, 'function_declarator')) {
        extractFunction(node, source, symbols, parentName, access, true);
        return;
      }
    }
    // Nested class/struct/enum
    if (child.type === 'class_specifier' || child.type === 'struct_specifier') {
      extractClassOrStruct(child, source, symbols, parentName);
      return;
    }
    if (child.type === 'enum_specifier') {
      extractEnum(child, source, symbols, parentName);
      return;
    }
  }

  // Check if it's a function declaration via init_declarator / pointer / reference declarator containing function_declarator
  const declarators = node.children.filter(c =>
    c.type === 'init_declarator' ||
    c.type === 'function_declarator' ||
    c.type === 'pointer_declarator' ||
    c.type === 'reference_declarator'
  );
  for (const decl of declarators) {
    const funcDecl = decl.type === 'function_declarator' ? decl : findDeepChild(decl, 'function_declarator');
    if (funcDecl) {
      extractFunction(node, source, symbols, parentName, access, true);
      return;
    }
  }

  // Field or variable declaration
  if (parentName) {
    extractField(node, source, symbols, parentName, access);
  } else {
    extractGlobalVariable(node, source, symbols);
  }
}

function extractField(
  node: Parser.SyntaxNode,
  source: string,
  symbols: ExtractedSymbol[],
  parentName: string,
  access: string | null,
): void {
  const typeNode = node.childForFieldName('type');
  const type = typeNode ? typeNode.text : '';
  const isStatic = hasStorageSpecifier(node, 'static');

  for (const child of node.children) {
    if (child.type === 'field_declaration_list_item' || child.type === 'init_declarator') {
      const nameNode = findDeepChild(child, 'field_identifier') || findDeepChild(child, 'identifier');
      if (nameNode) {
        const qualifiedName = `${parentName}::${nameNode.text}`;
        symbols.push({
          name: nameNode.text,
          qualifiedName,
          kind: 'field',
          access,
          isStatic,
          isVirtual: false,
          isConst: node.text.includes('const'),
          isInline: false,
          returnType: type,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          columnStart: node.startPosition.column,
          signature: `${type} ${nameNode.text}`,
          rawText: truncateText(node.text, 300),
          parentName,
          parameters: [],
          baseClasses: [],
          children: [],
        });
      }
    }
  }

  // Direct field identifiers
  const directFieldId = findChild(node, 'field_identifier');
  const directId = directFieldId || findChild(node, 'identifier');
  if (directId && !node.children.some(c => c.type === 'init_declarator' || c.type === 'function_declarator')) {
    // Avoid double-extraction if handled above
    const existing = symbols.find(s => s.name === directId.text && s.lineStart === node.startPosition.row + 1);
    if (!existing) {
      const qualifiedName = `${parentName}::${directId.text}`;
      symbols.push({
        name: directId.text,
        qualifiedName,
        kind: 'field',
        access,
        isStatic,
        isVirtual: false,
        isConst: node.text.includes('const'),
        isInline: false,
        returnType: type,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        columnStart: node.startPosition.column,
        signature: `${type} ${directId.text}`,
        rawText: truncateText(node.text, 300),
        parentName,
        parameters: [],
        baseClasses: [],
        children: [],
      });
    }
  }
}

function extractGlobalVariable(
  node: Parser.SyntaxNode,
  source: string,
  symbols: ExtractedSymbol[],
): void {
  // Only extract if it looks like a meaningful global
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const idNode = findChild(node, 'identifier') || findChild(node, 'init_declarator');
  if (!idNode) return;

  const name = idNode.type === 'identifier' ? idNode.text : (findDeepChild(idNode, 'identifier')?.text ?? '');
  if (!name) return;

  symbols.push({
    name,
    qualifiedName: name,
    kind: 'variable',
    access: null,
    isStatic: hasStorageSpecifier(node, 'static'),
    isVirtual: false,
    isConst: node.text.includes('const'),
    isInline: false,
    returnType: typeNode.text,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    columnStart: node.startPosition.column,
    signature: null,
    rawText: truncateText(node.text, 200),
    parentName: null,
    parameters: [],
    baseClasses: [],
    children: [],
  });
}

function extractEnum(
  node: Parser.SyntaxNode,
  source: string,
  symbols: ExtractedSymbol[],
  parentName: string | null,
): void {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : '<anonymous_enum>';
  const qualifiedName = parentName ? `${parentName}::${name}` : name;
  const children: ExtractedSymbol[] = [];

  const body = node.childForFieldName('body');
  if (body) {
    for (const enumerator of body.children) {
      if (enumerator.type === 'enumerator') {
        const enumName = enumerator.childForFieldName('name');
        if (enumName) {
          children.push({
            name: enumName.text,
            qualifiedName: `${qualifiedName}::${enumName.text}`,
            kind: 'enum_value',
            access: null,
            isStatic: false,
            isVirtual: false,
            isConst: true,
            isInline: false,
            returnType: null,
            lineStart: enumerator.startPosition.row + 1,
            lineEnd: enumerator.endPosition.row + 1,
            columnStart: enumerator.startPosition.column,
            signature: null,
            rawText: enumerator.text,
            parentName: name,
            parameters: [],
            baseClasses: [],
            children: [],
          });
        }
      }
    }
  }

  symbols.push({
    name,
    qualifiedName,
    kind: 'enum',
    access: null,
    isStatic: false,
    isVirtual: false,
    isConst: false,
    isInline: false,
    returnType: null,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    columnStart: node.startPosition.column,
    signature: null,
    rawText: truncateText(node.text, 500),
    parentName,
    parameters: [],
    baseClasses: [],
    children,
  });
}

function extractNamespace(
  node: Parser.SyntaxNode,
  source: string,
  symbols: ExtractedSymbol[],
  parentName: string | null,
): void {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : '<anonymous>';
  const qualifiedName = parentName ? `${parentName}::${name}` : name;

  const body = node.childForFieldName('body');
  if (body) {
    for (const child of body.children) {
      extractFromNode(child, source, symbols, qualifiedName, null);
    }
  }
}

function extractTemplate(
  node: Parser.SyntaxNode,
  source: string,
  symbols: ExtractedSymbol[],
  parentName: string | null,
  access: string | null,
): void {
  // Extract the inner declaration
  for (const child of node.children) {
    if (child.type !== 'template_parameter_list') {
      extractFromNode(child, source, symbols, parentName, access);
    }
  }
}

function extractTypedef(
  node: Parser.SyntaxNode,
  source: string,
  symbols: ExtractedSymbol[],
  parentName: string | null,
): void {
  const nameNode = findChild(node, 'type_identifier') || findChild(node, 'identifier');
  if (!nameNode) return;

  symbols.push({
    name: nameNode.text,
    qualifiedName: parentName ? `${parentName}::${nameNode.text}` : nameNode.text,
    kind: 'typedef',
    access: null,
    isStatic: false,
    isVirtual: false,
    isConst: false,
    isInline: false,
    returnType: null,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    columnStart: node.startPosition.column,
    signature: node.text,
    rawText: truncateText(node.text, 300),
    parentName,
    parameters: [],
    baseClasses: [],
    children: [],
  });
}

function extractMacroDefinition(
  node: Parser.SyntaxNode,
  source: string,
  symbols: ExtractedSymbol[],
  parentName: string | null,
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  symbols.push({
    name: nameNode.text,
    qualifiedName: nameNode.text,
    kind: 'macro_definition',
    access: null,
    isStatic: false,
    isVirtual: false,
    isConst: false,
    isInline: false,
    returnType: null,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    columnStart: node.startPosition.column,
    signature: null,
    rawText: truncateText(node.text, 300),
    parentName,
    parameters: [],
    baseClasses: [],
    children: [],
  });
}

// --- Helpers ---

function extractFunctionName(declarator: Parser.SyntaxNode): { name: string; qualifiedParent: string | null } {
  // Look for function_declarator -> declarator which can be qualified_identifier
  let nameNode = declarator.childForFieldName('declarator');
  if (!nameNode) nameNode = declarator;

  // Drill through pointer/reference declarators
  while (nameNode && (nameNode.type === 'pointer_declarator' || nameNode.type === 'reference_declarator')) {
    nameNode = nameNode.childForFieldName('declarator') || nameNode.children[1] || nameNode;
    if (nameNode.type === 'pointer_declarator' || nameNode.type === 'reference_declarator') continue;
    break;
  }

  if (nameNode?.type === 'qualified_identifier') {
    const scope = nameNode.childForFieldName('scope');
    const nameChild = nameNode.childForFieldName('name');
    return {
      name: nameChild?.text || nameNode.text,
      qualifiedParent: scope?.text?.replace(/::$/, '') || null,
    };
  }

  if (nameNode?.type === 'destructor_name') {
    return { name: nameNode.text, qualifiedParent: null };
  }

  // Check for function_declarator within
  const funcDecl = nameNode?.type === 'function_declarator' ? nameNode : findChild(nameNode!, 'function_declarator');
  if (funcDecl) {
    return extractFunctionName(funcDecl);
  }

  const identifier = findDeepChild(nameNode!, 'identifier') || findDeepChild(nameNode!, 'field_identifier');
  return { name: identifier?.text || nameNode?.text || '', qualifiedParent: null };
}

function extractReturnType(node: Parser.SyntaxNode): string | null {
  const typeNode = node.childForFieldName('type');
  if (typeNode) return typeNode.text;

  // Check for primitive types before declarator
  for (const child of node.children) {
    if (child.type === 'primitive_type' || child.type === 'type_identifier' || child.type === 'qualified_identifier') {
      return child.text;
    }
    if (child.type === 'function_declarator' || child.type === 'declaration') break;
  }
  return null;
}

function extractParameters(declarator: Parser.SyntaxNode): ExtractedParameter[] {
  const params: ExtractedParameter[] = [];
  const paramList = findChild(declarator, 'parameter_list');
  if (!paramList) return params;

  let position = 0;
  for (const param of paramList.children) {
    if (param.type === 'parameter_declaration') {
      const typeNode = param.childForFieldName('type');
      const declNode = param.childForFieldName('declarator');
      const defaultNode = param.childForFieldName('default_value');

      let paramName: string | null = null;
      if (declNode) {
        const id = findDeepChild(declNode, 'identifier');
        paramName = id?.text || declNode.text;
      }

      params.push({
        name: paramName,
        type: typeNode?.text || param.text,
        defaultValue: defaultNode?.text || null,
        position,
      });
      position++;
    } else if (param.type === 'variadic_parameter_declaration' || param.type === 'variadic_parameter') {
      params.push({
        name: '...',
        type: '...',
        defaultValue: null,
        position,
      });
      position++;
    }
  }
  return params;
}

function hasStorageSpecifier(node: Parser.SyntaxNode, specifier: string): boolean {
  return node.children.some(
    c => (c.type === 'storage_class_specifier' || c.type === 'type_qualifier') && c.text === specifier
  );
}

function hasSpecifier(node: Parser.SyntaxNode, specifier: string): boolean {
  return node.children.some(c => c.text === specifier);
}

function buildSignature(
  returnType: string | null,
  name: string,
  params: ExtractedParameter[],
  isConst: boolean,
): string {
  const paramStr = params.map(p => {
    let s = p.type;
    if (p.name) s += ` ${p.name}`;
    if (p.defaultValue) s += ` = ${p.defaultValue}`;
    return s;
  }).join(', ');
  let sig = '';
  if (returnType) sig += `${returnType} `;
  sig += `${name}(${paramStr})`;
  if (isConst) sig += ' const';
  return sig;
}

function findChild(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
  for (const child of node.children) {
    if (child.type === type) return child;
  }
  return null;
}

function findDeepChild(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
  if (node.type === type) return node;
  for (const child of node.children) {
    const found = findDeepChild(child, type);
    if (found) return found;
  }
  return null;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}
