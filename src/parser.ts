import {
  DocBlock,
  DocCodeSpan,
  DocComment, DocErrorText, DocFencedCode,
  DocNodeKind,
  DocPlainText,
  DocSection,
  DocSoftBreak,
  TSDocParser
} from "@microsoft/tsdoc";
import * as ts from "typescript";
import * as fs from "fs";
import {PropertySignature, TypeNode} from "typescript";

export interface Result {
  methodName: string;
  description: string;
  exampleCode: {content: string, language: string} | null;
  parameters: {
    name: string;
    type: string;
    description: string;
    required: boolean;
    parameters: {
      name: string;
      type: string;
      description: string;
      required: boolean;
    }[];
  }[];
  deprecated: string | null;
  returns: {
    type: string;
    description: string;
  };
}

const sectionToMarkdown = (section: DocSection): string => {
  if (!section) {
    throw new Error('No description found');
  }

  if (section.nodes.length === 0) {
    return '';
  }
  
  const nodes = section.nodes[0].getChildNodes();
  let ret = '';
  for (const node of nodes) {
    if (node instanceof DocPlainText) {
      ret += node.text;
    } else if (node instanceof DocSoftBreak) {
      ret += ' ';
    } else if (node instanceof DocCodeSpan) {
      ret += "`" + node.code + "`";
    } else if (node instanceof DocErrorText) {
      ret += node.text;
    } else {
      throw new Error(`Unexpected node type: ${node.kind}`);
    }
  }
    
  return ret.trim();
}

const getExampleCode = (customBlocks: ReadonlyArray<DocBlock>) => {
  const exampleBlock = customBlocks.find(block => block.blockTag.tagName === '@example');
  if (!exampleBlock)
    return null;
  
  const fencedCode = exampleBlock.content.nodes.find(n => n.kind === DocNodeKind.FencedCode) as DocFencedCode;
  if (!fencedCode)
      return null;
  
  return {
    content: fencedCode.code,
    language: fencedCode.language,
  };
};

const getTypeName = (type?: TypeNode): string => {
  if (!type)
    return 'unknown';
  
  const kindTypeMap = {
    [ts.SyntaxKind.StringKeyword]: 'string',
    [ts.SyntaxKind.NumberKeyword]: 'number',
    [ts.SyntaxKind.BooleanKeyword]: 'boolean',
    [ts.SyntaxKind.VoidKeyword]: 'void',
    [ts.SyntaxKind.UndefinedKeyword]: 'undefined',
    [ts.SyntaxKind.NullKeyword]: 'null',
    [ts.SyntaxKind.AnyKeyword]: 'any',
    [ts.SyntaxKind.UnknownKeyword]: 'unknown',
    [ts.SyntaxKind.NeverKeyword]: 'never',
    [ts.SyntaxKind.ObjectKeyword]: 'object',
  };
  
  if (kindTypeMap[type.kind])
    return kindTypeMap[type.kind];
  
  if (!type)
    return 'unknown';
  
  if (ts.isTypeReferenceNode(type))
    return type.typeName.getText();
  
  if (ts.isUnionTypeNode(type))
    return type.types.map(t => getTypeName(t)).join(' | ');
  
  if (ts.isParenthesizedTypeNode(type))
    return getTypeName(type.type);
  
  if (ts.isFunctionTypeNode(type)) {
      const params = type.parameters.map(p => `${p.name.getText()}: ${getTypeName(p.type)}`);
      const returnType = getTypeName(type.type);
      return `(${params.join(', ')}) => ${returnType}`;
  }
  
  if (ts.isTypeLiteralNode(type))
    return 'object';
  
  if (ts.isArrayTypeNode(type))
    return getTypeName(type.elementType) + '[]';
  
  if (ts.isLiteralTypeNode(type)) {
    return type.literal.getText();
  }
  
  console.error(`Unknown type: ${type.kind}`);
}

const convertParamDeclaration = (param: ts.ParameterDeclaration, comment: DocComment | null, typeToParametersMap: Map<string, {name: string, type: string, description: string, required: boolean}[]>): {name: string, type: string, description: string, required: boolean, parameters: {name: string, type: string, description: string, required: boolean}[]} => {
  const paramName = param.name.getText();
  const paramType = getTypeName(param.type);
  const paramDoc = comment ? comment.params.blocks.find(block => block.parameterName === paramName) : null;
  const parameters = typeToParametersMap.get(paramType) || [];
  
  return {
    name: paramName,
    type: paramType,
    description: paramDoc ? sectionToMarkdown(paramDoc.content) : '',
    required: !param.questionToken,
    parameters: parameters,
  };
};

const getLocalImports = (sourceFile: ts.SourceFile): ts.SourceFile[] => {
  const result = [];
  
    const visit = (node: ts.Node) => {
      if (!ts.isImportDeclaration(node))
        return ts.forEachChild(node, visit);
      
      const moduleSpecifier = node.moduleSpecifier.getText();
        if (!moduleSpecifier.startsWith('".') && !moduleSpecifier.startsWith("'.") && !moduleSpecifier.startsWith('`.')) {
            return;
        }
        
        const importPath = moduleSpecifier.substring(1, moduleSpecifier.length - 1);
        const dirName = sourceFile.fileName.substring(0, sourceFile.fileName.lastIndexOf('/'));
        const importFileName = dirName + '/' + importPath + '.ts';
        if (!fs.existsSync(importFileName)) {
          console.error(`File in import (${importFileName}) does not exist`);
          return;
        }
        
        const importFileContents = fs.readFileSync(importFileName, 'utf8');
        const importSourceFile = ts.createSourceFile(importFileName, importFileContents, ts.ScriptTarget.ES2015, true);
        result.push(importSourceFile);
    };
    
    ts.forEachChild(sourceFile, visit);
    return result;
}

const getTypesToParametersMap = (fileName: string): Map<string, {name: string, type: string, description: string, required: boolean}[]>  => {
  const result = new Map<string, {name: string, type: string, description: string, required: boolean}[]>();
  
  const fileContents = fs.readFileSync(fileName, 'utf8');
  const sourceFile = ts.createSourceFile(fileName, fileContents, ts.ScriptTarget.ES2015, true);
  const sourceFiles = [
    sourceFile,
    ...getLocalImports(sourceFile)
  ]
  
  const visit = (node: ts.Node) => {
    if (!ts.isInterfaceDeclaration(node))
      return ts.forEachChild(node, visit);
    
    const interfaceName = node.name.getText();
    const members = node.members.filter(m => ts.isPropertySignature(m))
        .map(m => m as PropertySignature);
    if (members.length === 0)
      return;

    const fileContent = node.getSourceFile().text;
    const properties = members.map(m => {
      const commentRanges = ts.getLeadingCommentRanges(fileContent, m.pos);
      const commentStr = commentRanges ? fileContent.substring(commentRanges[0].pos, commentRanges[0].end) : '';
      const comment = new TSDocParser().parseString(commentStr).docComment;
      
      const name = m.name.getText();
      const description = comment.summarySection ? sectionToMarkdown(comment.summarySection) : '';
      const type = m.type ? getTypeName(m.type) : 'unknown';
      
      const required = !m.questionToken;
      return {name, type, description, required};
    });
    
    result.set(interfaceName, properties);
  }

  for (const file of sourceFiles) {
    ts.forEachChild(file, visit);
  }

  return result;
}

const getComment = (node: ts.Node, sourceFile: ts.SourceFile, parser: TSDocParser): DocComment | null => {
    const commentRanges = ts.getLeadingCommentRanges(sourceFile.text, node.pos);
    if (!commentRanges)
        return null;
    
    const commentStr = sourceFile.text.substring(commentRanges[0].pos, commentRanges[0].end);
    return parser.parseString(commentStr).docComment;
}

export const parseTypeScriptFile = (fileName: string, className: string | undefined): Result[] => {
  const typeToParametersMap = getTypesToParametersMap(fileName);
  
  const fileContents = fs.readFileSync(fileName, 'utf8');
  const sourceFile = ts.createSourceFile(fileName, fileContents, ts.ScriptTarget.ES2015, true);
  
  const parser = new TSDocParser();
  const results = [];

  const visit = (node: ts.Node) => {
    if (!ts.isMethodDeclaration(node) && !ts.isConstructorDeclaration(node)) {
      return ts.forEachChild(node, visit);
    }
    
    const parent = node.parent;
    if (className !== undefined && (!parent || !ts.isClassDeclaration(parent) || parent.name.getText() !== className))
      return ts.forEachChild(node, visit);
    
    const excludedModifiers = [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword];
    if (node.modifiers && node.modifiers.some(mod => excludedModifiers.includes(mod.kind)))
      return ts.forEachChild(node, visit);
    
    const comment = getComment(node, sourceFile, parser);

    const methodName = node.name ? node.name.getText(sourceFile) : 'constructor';
    const description = comment ? sectionToMarkdown(comment.summarySection) : '';

    const parameters = node.parameters.map(p => convertParamDeclaration(p, comment, typeToParametersMap));
    
    const deprecated = comment?.deprecatedBlock ? sectionToMarkdown(comment.deprecatedBlock.content) : null;

    const returnType = node.type ? node.type.getText(sourceFile) : 'void';
    const returnDescription = comment?.returnsBlock 
        ? sectionToMarkdown(comment.returnsBlock.content)
        : '';
    
    const exampleCode = comment ? getExampleCode(comment.customBlocks) : null;

    results.push({
      methodName,
      description,
      example: exampleCode,
      parameters,
      deprecated,
      returns: {
       type: returnType,
        description: returnDescription,
      },
    });

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return results;
}

