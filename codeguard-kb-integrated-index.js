import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import ora from 'ora';
import chalk from 'chalk';
import readline from 'readline';

// ============================================================================
// CODEGUARD - STANDALONE WITH GITHUB KNOWLEDGE BASE
// ============================================================================

const KB_REPO = 'eozdemir23/sup-codeguard-kb'; // GitHub Knowledge Base repo
const KB_RAW_URL = 'https://raw.githubusercontent.com/' + KB_REPO + '/main';
const KB_DIR = path.join(process.cwd(), '.codeguard/kb');
const REPORT_DIR = path.join(process.cwd(), '.codeguard/reports');
const CONFIG_FILE = path.join(process.cwd(), '.codeguard-config.json');
const CACHE_FILE = path.join(KB_DIR, 'patterns-cache.json');

const SUPPORTED_EXTENSIONS = ['.js', '.ts', '.tsx', '.json', '.md', '.yml', '.yaml', '.css', '.scss', '.html'];

const SEVERITY = {
    CRITICAL: { level: 0, color: 'red', icon: '🔴', weight: 10 },
    HIGH: { level: 1, color: 'red', icon: '🟠', weight: 7 },
    MEDIUM: { level: 2, color: 'yellow', icon: '🟡', weight: 4 },
    LOW: { level: 3, color: 'cyan', icon: '🟢', weight: 1 }
};

// ============================================================================
// KNOWLEDGE BASE MANAGER
// ============================================================================

class KnowledgeBaseManager {
    constructor() {
        this.rules = {};
        this.patterns = {};
        this.loaded = false;
    }

    async downloadFromGitHub(filePath) {
        return new Promise((resolve, reject) => {
            const url = `${KB_RAW_URL}/${filePath}`;
            https.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try { resolve(JSON.parse(data)); } catch { resolve(null); }
                    } else {
                        reject(new Error(`Failed to download: ${filePath}`));
                    }
                });
            }).on('error', reject);
        });
    }

    async initializeKB() {
        if (!fs.existsSync(KB_DIR)) {
            fs.mkdirSync(KB_DIR, { recursive: true });
        }

        const spinner = ora('Downloading Knowledge Base from GitHub...').start();

        try {
            // Download compiled patterns
            const compiledPatterns = await this.downloadFromGitHub('patterns/compiled-patterns.json');
            if (compiledPatterns) {
                this.patterns = compiledPatterns.compiledPatterns || {};
                fs.writeFileSync(CACHE_FILE, JSON.stringify(this.patterns, null, 2));
                spinner.succeed(chalk.green('✔ Knowledge Base initialized with ' + Object.keys(this.patterns).length + ' rule categories'));
                this.loaded = true;
                return true;
            }
        } catch (err) {
            spinner.warn(chalk.yellow('⚠️  Could not download KB, using local cache if available'));
            if (fs.existsSync(CACHE_FILE)) {
                this.patterns = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
                this.loaded = true;
                return true;
            }
        }

        return false;
    }

    async updateKB() {
        const spinner = ora('Updating Knowledge Base...').start();
        try {
            const updated = await this.initializeKB();
            if (updated) {
                spinner.succeed(chalk.green('✔ Knowledge Base updated successfully'));
            }
        } catch (err) {
            spinner.fail(chalk.red('Failed to update KB: ' + err.message));
        }
    }

    getRule(ruleId) {
        for (const category of Object.values(this.patterns)) {
            if (category[ruleId]) {
                return category[ruleId];
            }
        }
        return null;
    }
}

// ============================================================================
// CODE ANALYZER
// ============================================================================

class CodeAnalyzer {
    constructor(kb) {
        this.kb = kb;
        this.issues = [];
        this.stats = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
    }

    addIssue(file, line, severity, ruleId, message, suggestion, code = null) {
        const issue = {
            file,
            line,
            severity,
            ruleId,
            message,
            suggestion,
            code,
            riskScore: SEVERITY[severity].weight
        };
        this.issues.push(issue);
        this.stats.total++;
        this.stats[severity.toLowerCase()]++;
    }

    testPatterns(filePath, content, lines) {
        // KB'deki tüm pattern'leri test et
        for (const [category, rules] of Object.entries(this.kb.patterns)) {
            for (const [ruleId, rule] of Object.entries(rules)) {
                if (rule.patterns && Array.isArray(rule.patterns)) {
                    lines.forEach((line, idx) => {
                        const lineNum = idx + 1;

                        for (const patternStr of rule.patterns) {
                            try {
                                const regex = new RegExp(patternStr, 'gi');
                                if (regex.test(line)) {
                                    this.addIssue(
                                        filePath,
                                        lineNum,
                                        rule.severity || 'MEDIUM',
                                        ruleId,
                                        rule.name || 'Code Issue',
                                        this.generateSuggestion(ruleId, rule),
                                        line.trim()
                                    );
                                }
                            } catch (e) {
                                // Invalid regex, skip
                            }
                        }
                    });
                }
            }
        }
    }

    generateSuggestion(ruleId, rule) {
        // KB'deki solution'lardan akıllı suggestion üret
        const suggestions = [];

        // Kategori bazında genel öneriler
        if (ruleId.includes('SQL')) {
            suggestions.push('Use parameterized queries instead of string concatenation');
            suggestions.push('Example: db.query("SELECT * FROM users WHERE id = ?", [userId])');
        }
        if (ruleId.includes('XSS')) {
            suggestions.push('Use textContent instead of innerHTML: element.textContent = input');
            suggestions.push('If HTML is needed, sanitize with DOMPurify or similar library');
        }
        if (ruleId.includes('HARDCODED')) {
            suggestions.push('Move to environment variables: const key = process.env.API_KEY');
            suggestions.push('Use a .env file and load with dotenv package');
        }
        if (ruleId.includes('ERROR')) {
            suggestions.push('Wrap in try-catch: try { await operation() } catch(e) { handle(e) }');
            suggestions.push('Or use .catch(): promise.catch(err => handleError(err))');
        }
        if (ruleId.includes('UNUSED')) {
            suggestions.push('Remove unused variable or prefix with underscore: _varName');
        }
        if (ruleId.includes('PERFORMANCE')) {
            suggestions.push('Batch operations or use indexes');
            suggestions.push('Avoid database calls inside loops');
        }

        return suggestions[0] || 'Fix this issue according to best practices';
    }

    analyzeFile(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');

            // KB pattern'lerini test et
            this.testPatterns(filePath, content, lines);

            // Ek heuristic kontroller
            this.additionalChecks(filePath, content, lines);
        } catch (err) {
            // File read error, skip
        }
    }

    additionalChecks(filePath, content, lines) {
        const ext = path.extname(filePath).toLowerCase();

        // JSON dosyaları için syntax kontrolü
        if (ext === '.json') {
            try {
                JSON.parse(content);
            } catch (e) {
                this.addIssue(filePath, 1, 'CRITICAL', 'JSON_001',
                    'Invalid JSON syntax',
                    'Fix JSON formatting: ' + e.message.substring(0, 50),
                    lines[0] || '');
            }
        }

        // Complexity checks
        lines.forEach((line, idx) => {
            const lineNum = idx + 1;

            // Very long lines
            if (line.length > 120) {
                this.addIssue(filePath, lineNum, 'LOW', 'LINE_001',
                    'Line too long (>120 characters)',
                    'Break into multiple lines for readability',
                    line.substring(0, 50) + '...');
            }

            // Missing documentation on exports
            if (/(export\s+(function|const|class)\s+\w+|async\s+function)/.test(line)) {
                if (idx === 0 || !lines[idx - 1].includes('/**') && !lines[idx - 1].includes('//')) {
                    this.addIssue(filePath, lineNum, 'LOW', 'DOC_001',
                        'Missing documentation',
                        'Add JSDoc comment: /** Description of function */',
                        line.trim());
                }
            }
        });
    }

    getRiskScore() {
        if (this.issues.length === 0) return 0;
        const weights = this.issues.reduce((sum, issue) => sum + issue.riskScore, 0);
        return Math.min(100, Math.round((weights / (this.issues.length * 10)) * 100));
    }

    formatReport() {
        const riskScore = this.getRiskScore();
        let output = '\n';
        output += chalk.cyan.bold('┌─────────────────────────────────────────────────┐\n');
        output += chalk.cyan.bold('│      CODE GUARD - KNOWLEDGE BASE ANALYSIS        │\n');
        output += chalk.cyan.bold('├─────────────────────────────────────────────────┤\n');
        output += chalk.cyan(`│ Scanned: ${new Date().toLocaleString().padEnd(39)}│\n`);
        output += chalk.cyan(`│ Risk Score: ${riskScore}/100`.padEnd(49) + '│\n');
        output += chalk.cyan(`│ Total Issues: ${this.stats.total}`.padEnd(49) + '│\n');
        output += chalk.cyan(`│ KB Rules Applied: ${Object.keys(this.kb.patterns).length}`.padEnd(49) + '│\n');
        output += chalk.cyan.bold('└─────────────────────────────────────────────────┘\n\n');

        // Group by severity
        const bySeverity = Object.keys(SEVERITY).reduce((acc, sev) => {
            acc[sev] = this.issues.filter(i => i.severity === sev);
            return acc;
        }, {});

        for (const [severity, issues] of Object.entries(bySeverity)) {
            if (issues.length > 0) {
                const icon = SEVERITY[severity].icon;
                const color = SEVERITY[severity].color;
                output += chalk[color](`${icon} ${severity} (${issues.length})\n`);

                issues.slice(0, 10).forEach((issue, idx) => {
                    output += chalk.white(`   [L${issue.line}] ${issue.ruleId} - ${issue.message}\n`);
                    output += chalk.green(`       💡 ${issue.suggestion}\n`);
                    if (idx < Math.min(issues.length - 1, 9)) output += '\n';
                });

                if (issues.length > 10) {
                    output += chalk.gray(`   ... and ${issues.length - 10} more\n`);
                }
                output += '\n';
            }
        }

        return output;
    }

    saveReport(filename = null) {
        if (!fs.existsSync(REPORT_DIR)) {
            fs.mkdirSync(REPORT_DIR, { recursive: true });
        }
        const fname = filename || `report-${Date.now()}.json`;
        const filepath = path.join(REPORT_DIR, fname);
        fs.writeFileSync(filepath, JSON.stringify({
            timestamp: new Date().toISOString(),
            riskScore: this.getRiskScore(),
            stats: this.stats,
            kbVersion: 'latest',
            issues: this.issues
        }, null, 2));
        return filepath;
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
    }
    return { offlineMode: true, autoUpdate: true };
}

function getAllFiles(dir, baseDir = dir, files = []) {
    const ignore = ['node_modules', '.git', 'dist', 'build', '.cache', '.codeguard', '.next', '__pycache__'];
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return files; }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const relPath = path.relative(baseDir, fullPath);

        if (ignore.some(i => relPath.startsWith(i))) continue;

        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) getAllFiles(fullPath, baseDir, files);
            else if (SUPPORTED_EXTENSIONS.includes(path.extname(fullPath).toLowerCase())) files.push(fullPath);
        } catch {}
    }
    return files;
}

// ============================================================================
// MAIN PLUGIN
// ============================================================================

export async function run(sup, args) {
    const command = args[0] || 'scan';

    // Knowledge Base Manager başlat
    const kb = new KnowledgeBaseManager();

    if (command === 'init') {
        console.log(chalk.cyan.bold('\n🔧 Initializing CodeGuard with Knowledge Base...\n'));
        const success = await kb.initializeKB();
        if (success) {
            console.log(chalk.green('\n✔ CodeGuard is ready to use!\n'));
            console.log(chalk.gray('Commands:'));
            console.log(chalk.gray('  sup codeguard scan           - Analyze project'));
            console.log(chalk.gray('  sup codeguard update-kb      - Update rules from GitHub'));
            console.log(chalk.gray('  sup codeguard report <file>  - View specific report\n'));
        }
        return;
    }

    if (command === 'scan') {
        // KB'yi yükle
        const initialized = await kb.initializeKB();
        if (!initialized) {
            console.log(chalk.red('❌ Failed to initialize Knowledge Base'));
            console.log(chalk.gray('Try: sup codeguard update-kb'));
            return;
        }

        // Projeyi tara
        const spinner = ora('Scanning project with Knowledge Base rules...').start();
        const analyzer = new CodeAnalyzer(kb);

        const files = getAllFiles(process.cwd());
        spinner.text = `Found ${files.length} files to analyze...`;

        let analyzed = 0;
        files.forEach(file => {
            analyzer.analyzeFile(file);
            analyzed++;
            spinner.text = `Analyzing: ${analyzed}/${files.length}...`;
        });

        spinner.stop();

        if (analyzer.stats.total === 0) {
            console.log(chalk.green.bold('\n✨ Perfect! No issues found.\n'));
            return;
        }

        console.log(analyzer.formatReport());

        // Save report
        const reportPath = analyzer.saveReport();
        console.log(chalk.gray(`📄 Report saved to: ${reportPath}\n`));

        // Risk warning
        const riskScore = analyzer.getRiskScore();
        if (riskScore >= 70) {
            console.log(chalk.red.bold(`\n⚠️  HIGH RISK - Score: ${riskScore}/100\n`));
        } else if (riskScore >= 40) {
            console.log(chalk.yellow.bold(`\n⚠️  MEDIUM RISK - Score: ${riskScore}/100\n`));
        } else {
            console.log(chalk.green(`\n✅ LOW RISK - Score: ${riskScore}/100\n`));
        }

        return;
    }

    if (command === 'update-kb') {
        await kb.updateKB();
        return;
    }

    if (command === 'report') {
        const reportName = args[1];
        if (!reportName) {
            console.log(chalk.red('Usage: sup codeguard report <filename>'));
            return;
        }
        const reportPath = path.join(REPORT_DIR, reportName);
        if (fs.existsSync(reportPath)) {
            const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
            console.log(chalk.cyan.bold('\nReport: ' + reportName));
            console.log(chalk.gray('Timestamp: ' + report.timestamp));
            console.log(chalk.gray('Risk Score: ' + report.riskScore + '/100'));
            console.log(JSON.stringify(report, null, 2));
        } else {
            console.log(chalk.red('Report not found'));
        }
        return;
    }

    console.log(chalk.yellow('Unknown command. Use: init, scan, update-kb, or report'));
}

export function verify() {
    return "!1qaz2WSX3edc4RFV%56";
}
