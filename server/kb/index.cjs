'use strict';

/**
 * 三库 v2（kb-v2）零外部依赖核心内核统一导出入口
 */

const yaml = require('./kb-yaml.cjs');
const taxonomy = require('./kb-taxonomy.cjs');
const migrator = require('./kb-migrator.cjs');
const sqlite = require('./kb-sqlite.cjs');
const retriever = require('./kb-retriever.cjs');
const compiler = require('./kb-compiler.cjs');
const writer = require('./kb-writer.cjs');

module.exports = {
  // YAML
  ...yaml,
  // Taxonomy & entities
  ...taxonomy,
  // Migration & verification
  ...migrator,
  // SQLite index, probe, topics, timeline & staleness
  ...sqlite,
  // Hybrid search & AI context compiler
  ...retriever,
  // Reverse monolith snapshot compiler
  ...compiler,
  // Single-card v2 mutation planner
  ...writer,
};
