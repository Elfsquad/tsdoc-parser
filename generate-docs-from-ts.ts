import {
  DocBlock,
  DocCodeSpan,
  DocComment, DocFencedCode,
  DocNodeKind,
  DocPlainText,
  DocSection,
  DocSoftBreak,
  TSDocParser
} from "@microsoft/tsdoc";
import * as fs from "fs";
import * as ts from "typescript";


const sectionToMarkdown = (section: DocSection): string => {
  if (!section) {
    throw new Error('No description found');
  }
  
  const nodes = section.nodes[0].getChildNodes();
  let ret = '';
  for (const node of nodes) {
    if (node instanceof DocPlainText) {
      ret += node.text;
    } else if (node instanceof DocSoftBreak) {
      ret += '\n';
    } else if (node instanceof DocCodeSpan) {
      ret += "`" + node.code + "`";
    } else {
      console.log(node);
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
  
  return fencedCode.code;
};

const convertParamDecleration = (sourceFile: ts.SourceFile, comment: DocComment, param: ts.ParameterDeclaration) => {
  const paramName = param.name.getText(sourceFile);
  const paramType = param.type ? param.type.getText(sourceFile) : 'unknown';
  const paramDoc = comment.params.blocks.find(block => block.parameterName === paramName);

  return {
    name: paramName,
    type: paramType,
    description: paramDoc ? sectionToMarkdown(paramDoc.content) : '',
    required: !param.questionToken,
  };
};

const parseTypeScriptFile = (fileName: string) => {
  const fileContents = fs.readFileSync(fileName, 'utf8');
  const sourceFile = ts.createSourceFile(fileName, fileContents, ts.ScriptTarget.ES2015, true);
  
  const parser = new TSDocParser();
  const results = [];

  const visit = (node: ts.Node) => {
    if (!ts.isMethodDeclaration(node) && !ts.isConstructorDeclaration(node)) {
      return ts.forEachChild(node, visit);
    }
    
    const excludedModifiers = [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword];
    if (node.modifiers && node.modifiers.some(mod => excludedModifiers.includes(mod.kind)))
      return ts.forEachChild(node, visit);
    
    const commentRanges = ts.getLeadingCommentRanges(fileContents, node.pos);
    if (!commentRanges)
      return ts.forEachChild(node, visit);
    
    const commentStr = fileContents.substring(commentRanges[0].pos, commentRanges[0].end);
    const comment = parser.parseString(commentStr).docComment;
    
    const methodName = node.name ? node.name.getText(sourceFile) : 'constructor';
    const description = sectionToMarkdown(comment.summarySection);

    const parameters = node.parameters.map(p => convertParamDecleration(sourceFile, comment, p));

    const returnType = node.type ? node.type.getText(sourceFile) : 'void';
    const returnDescription = comment.returnsBlock 
        ? sectionToMarkdown(comment.returnsBlock.content)
        : '';
    
    const exampleCode = getExampleCode(comment.customBlocks);
    
    results.push({
       methodName,
       description,
       code: exampleCode,
       parameters,
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

if (process.argv.length !== 4) {
  console.error('Usage: generate-docs-from-ts <inputFile> <outputFile>');
  process.exit(1);
}

const [,, inputFile, outputFile] = process.argv;
const tsDocComments = parseTypeScriptFile(inputFile);
fs.writeFileSync(outputFile, JSON.stringify(tsDocComments, null, 2));
