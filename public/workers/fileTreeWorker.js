// File Tree Worker - Processa operações pesadas de parsing de árvore de arquivos

// Tipos de mensagens que o worker pode processar
const MESSAGE_TYPES = {
  PARSE_FILE_TREE: 'PARSE_FILE_TREE',
  INDEX_DIRECTORY: 'INDEX_DIRECTORY',
  SEARCH_FILES: 'SEARCH_FILES',
  SORT_NODES: 'SORT_NODES',
  FILTER_FILES: 'FILTER_FILES'
};

// Tipos de resposta
const RESPONSE_TYPES = {
  TREE_PARSED: 'TREE_PARSED',
  DIRECTORY_INDEXED: 'DIRECTORY_INDEXED',
  FILES_FOUND: 'FILES_FOUND',
  NODES_SORTED: 'NODES_SORTED',
  FILES_FILTERED: 'FILES_FILTERED',
  ERROR: 'ERROR'
};

// Função para ordenar nós da árvore
function sortFileTreeNodes(nodes) {
  if (!Array.isArray(nodes)) return nodes;
  
  return nodes.sort((a, b) => {
    // Diretórios primeiro
    if (a.type === 'directory' && b.type === 'file') return -1;
    if (a.type === 'file' && b.type === 'directory') return 1;
    
    // Em seguida, ordem alfabética
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  }).map(node => ({
    ...node,
    children: node.children ? sortFileTreeNodes(node.children) : undefined
  }));
}

// Função para filtrar arquivos baseado em critérios
function filterFiles(tree, filter) {
  if (!tree) return null;
  
  const { showHidden = true, extensions = [], maxDepth = -1, searchTerm = '' } = filter;
  
  function filterNode(node, currentDepth = 0) {
    // Verifica profundidade máxima
    if (maxDepth >= 0 && currentDepth > maxDepth) {
      return null;
    }
    
    // Verifica arquivos ocultos
    if (!showHidden && node.name.startsWith('.')) {
      return null;
    }
    
    // Verifica extensões permitidas (apenas para arquivos)
    if (node.type === 'file' && extensions.length > 0) {
      const fileExt = node.extension || '';
      if (!extensions.includes(fileExt)) {
        return null;
      }
    }
    
    // Verifica termo de busca
    if (searchTerm && !node.name.toLowerCase().includes(searchTerm.toLowerCase())) {
      // Para diretórios, verifica se algum filho corresponde
      if (node.type === 'directory' && node.children) {
        const hasMatchingChild = node.children.some(child => 
          filterNode(child, currentDepth + 1) !== null
        );
        if (!hasMatchingChild) {
          return null;
        }
      } else if (node.type === 'file') {
        return null;
      }
    }
    
    // Processa filhos se for diretório
    if (node.type === 'directory' && node.children) {
      const filteredChildren = node.children
        .map(child => filterNode(child, currentDepth + 1))
        .filter(child => child !== null);
      
      return {
        ...node,
        children: filteredChildren
      };
    }
    
    return node;
  }
  
  return filterNode(tree);
}

// Função para buscar arquivos na árvore
function searchFiles(tree, query) {
  if (!tree || !query) return [];
  
  const results = [];
  const searchTerm = query.toLowerCase();
  
  function searchInNode(node, path = '') {
    const currentPath = path ? `${path}/${node.name}` : node.name;
    
    if (node.name.toLowerCase().includes(searchTerm)) {
      results.push({
        name: node.name,
        path: node.path || currentPath,
        type: node.type,
        parent: path
      });
    }
    
    if (node.type === 'directory' && node.children) {
      node.children.forEach(child => searchInNode(child, currentPath));
    }
  }
  
  searchInNode(tree);
  return results;
}

// Função para indexar diretório
function indexDirectory(tree) {
  if (!tree) return {};
  
  const index = {
    pathToNode: {},
    parentToChildren: {},
    typeIndex: { files: [], directories: [] },
    extensionIndex: {}
  };
  
  function indexNode(node, parent = null) {
    // Índice por path
    index.pathToNode[node.path] = node;
    
    // Índice parent-children
    if (parent) {
      if (!index.parentToChildren[parent.path]) {
        index.parentToChildren[parent.path] = [];
      }
      index.parentToChildren[parent.path].push(node);
    }
    
    // Índice por tipo
    if (node.type === 'file') {
      index.typeIndex.files.push(node.path);
      
      // Índice por extensão
      if (node.extension) {
        if (!index.extensionIndex[node.extension]) {
          index.extensionIndex[node.extension] = [];
        }
        index.extensionIndex[node.extension].push(node.path);
      }
    } else {
      index.typeIndex.directories.push(node.path);
    }
    
    // Recursivamente indexa filhos
    if (node.type === 'directory' && node.children) {
      node.children.forEach(child => indexNode(child, node));
    }
  }
  
  indexNode(tree);
  return index;
}

// Função principal para processar árvore de arquivos
function parseFileTree(tree, options = {}) {
  try {
    const startTime = performance.now();
    
    let processedTree = tree;
    
    // Aplica filtros se especificados
    if (options.filter) {
      processedTree = filterFiles(processedTree, options.filter);
    }
    
    // Ordena nós se solicitado
    if (options.sort !== false) {
      processedTree = sortFileTreeNodes(processedTree);
    }
    
    // Cria índice se solicitado
    let index = null;
    if (options.createIndex) {
      index = indexDirectory(processedTree);
    }
    
    const processingTime = performance.now() - startTime;
    
    return {
      tree: processedTree,
      index,
      stats: {
        processingTime,
        nodeCount: countNodes(processedTree),
        fileCount: countFiles(processedTree),
        directoryCount: countDirectories(processedTree)
      }
    };
  } catch (error) {
    throw new Error(`Failed to parse file tree: ${error.message}`);
  }
}

// Funções auxiliares para estatísticas
function countNodes(tree) {
  if (!tree) return 0;
  let count = 1;
  if (tree.children) {
    count += tree.children.reduce((sum, child) => sum + countNodes(child), 0);
  }
  return count;
}

function countFiles(tree) {
  if (!tree) return 0;
  let count = tree.type === 'file' ? 1 : 0;
  if (tree.children) {
    count += tree.children.reduce((sum, child) => sum + countFiles(child), 0);
  }
  return count;
}

function countDirectories(tree) {
  if (!tree) return 0;
  let count = tree.type === 'directory' ? 1 : 0;
  if (tree.children) {
    count += tree.children.reduce((sum, child) => sum + countDirectories(child), 0);
  }
  return count;
}

// Event listener principal do worker
self.addEventListener('message', (event) => {
  const { type, payload, id } = event.data;
  
  try {
    let result;
    let responseType;
    
    switch (type) {
      case MESSAGE_TYPES.PARSE_FILE_TREE:
        result = parseFileTree(payload.tree, payload.options);
        responseType = RESPONSE_TYPES.TREE_PARSED;
        break;
        
      case MESSAGE_TYPES.INDEX_DIRECTORY:
        result = indexDirectory(payload.tree);
        responseType = RESPONSE_TYPES.DIRECTORY_INDEXED;
        break;
        
      case MESSAGE_TYPES.SEARCH_FILES:
        result = searchFiles(payload.tree, payload.query);
        responseType = RESPONSE_TYPES.FILES_FOUND;
        break;
        
      case MESSAGE_TYPES.SORT_NODES:
        result = sortFileTreeNodes(payload.nodes);
        responseType = RESPONSE_TYPES.NODES_SORTED;
        break;
        
      case MESSAGE_TYPES.FILTER_FILES:
        result = filterFiles(payload.tree, payload.filter);
        responseType = RESPONSE_TYPES.FILES_FILTERED;
        break;
        
      default:
        throw new Error(`Unknown message type: ${type}`);
    }
    
    // Envia resposta de sucesso
    self.postMessage({
      type: responseType,
      payload: result,
      id,
      success: true
    });
    
  } catch (error) {
    // Envia resposta de erro
    self.postMessage({
      type: RESPONSE_TYPES.ERROR,
      payload: {
        message: error.message,
        stack: error.stack
      },
      id,
      success: false
    });
  }
});

// Exporta constantes para uso externo (se necessário)
self.MESSAGE_TYPES = MESSAGE_TYPES;
self.RESPONSE_TYPES = RESPONSE_TYPES;