const BASH_COMPLETION = `
# scrybe bash completion
_scrybe_completions() {
  local cur prev words cword
  _init_completion || return

  local top_cmds="project source search job branch index gc daemon hook init doctor status ps uninstall projects sources jobs branches"
  local project_cmds="add update remove list ls"
  local source_cmds="add update remove list ls"
  local search_cmds="code knowledge"
  local job_cmds="list ls"
  local branch_cmds="list ls pin unpin p u"
  local daemon_cmds="start stop status restart refresh install uninstall ensure-running"
  local hook_cmds="install uninstall"
  local completion_cmds="bash zsh powershell"

  if [[ "\${cword}" -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "\${top_cmds} completion" -- "\${cur}") )
    return
  fi

  case "\${words[1]}" in
    project)   COMPREPLY=( \$(compgen -W "\${project_cmds}" -- "\${cur}") ) ;;
    source)    COMPREPLY=( \$(compgen -W "\${source_cmds}" -- "\${cur}") ) ;;
    search)    COMPREPLY=( \$(compgen -W "\${search_cmds}" -- "\${cur}") ) ;;
    job)       COMPREPLY=( \$(compgen -W "\${job_cmds}" -- "\${cur}") ) ;;
    branch)    COMPREPLY=( \$(compgen -W "\${branch_cmds}" -- "\${cur}") ) ;;
    daemon)    COMPREPLY=( \$(compgen -W "\${daemon_cmds}" -- "\${cur}") ) ;;
    hook)      COMPREPLY=( \$(compgen -W "\${hook_cmds}" -- "\${cur}") ) ;;
    completion) COMPREPLY=( \$(compgen -W "\${completion_cmds}" -- "\${cur}") ) ;;
  esac
}

complete -F _scrybe_completions scrybe
`;

const ZSH_COMPLETION = `
#compdef scrybe

_scrybe() {
  local state

  _arguments \\
    '1: :->noun' \\
    '*: :->rest'

  case \$state in
    noun)
      local nouns
      nouns=(
        'project:Manage registered projects'
        'source:Manage indexable sources'
        'search:Search code or knowledge sources'
        'job:Manage background reindex jobs'
        'branch:Manage indexed branches'
        'index:Index or reindex a project'
        'gc:Remove orphan chunks'
        'daemon:Manage the background daemon'
        'hook:Manage git hooks'
        'init:First-run wizard'
        'doctor:Diagnose configuration'
        'status:Show scrybe health'
        'ps:Show scrybe health (alias for status)'
        'uninstall:Remove scrybe data and config'
        'completion:Print shell completion script'
        'projects:List all projects (shorthand)'
        'sources:List all sources (shorthand)'
        'jobs:List all jobs (shorthand)'
        'branches:List indexed branches (shorthand)'
      )
      _describe 'command' nouns
      ;;
    rest)
      case \$words[2] in
        project)
          local verbs=('add:Register a project' 'update:Update description' 'remove:Unregister a project' 'list:List all projects' 'ls:List all projects (alias)')
          _describe 'verb' verbs ;;
        source)
          local verbs=('add:Add a source' 'update:Update a source' 'remove:Remove a source' 'list:List sources' 'ls:List sources (alias)')
          _describe 'verb' verbs ;;
        search)
          local verbs=('code:Search code sources' 'knowledge:Search knowledge sources')
          _describe 'verb' verbs ;;
        job)
          local verbs=('list:List jobs' 'ls:List jobs (alias)')
          _describe 'verb' verbs ;;
        branch)
          local verbs=('list:List branches' 'ls:List (alias)' 'pin:Pin branches' 'p:Pin (alias)' 'unpin:Unpin branches' 'u:Unpin (alias)')
          _describe 'verb' verbs ;;
        daemon)
          local verbs=('start:Start' 'stop:Stop' 'restart:Restart' 'refresh:Trigger reindex' 'install:Register autostart' 'uninstall:Remove autostart' 'status:Deprecated - use scrybe status' 'ensure-running:Start if not running')
          _describe 'verb' verbs ;;
        hook)
          local verbs=('install:Install git hooks' 'uninstall:Remove git hooks')
          _describe 'verb' verbs ;;
        completion)
          local shells=('bash' 'zsh' 'powershell')
          _describe 'shell' shells ;;
      esac
      ;;
  esac
}

_scrybe
`;

const POWERSHELL_COMPLETION = `
Register-ArgumentCompleter -Native -CommandName scrybe -ScriptBlock {
  param(\$wordToComplete, \$commandAst, \$cursorPosition)

  \$tokens = \$commandAst.ToString().Split(' ', [StringSplitOptions]::RemoveEmptyEntries)

  \$topLevelCmds = @('project','source','search','job','branch','index','gc','daemon','hook','init','doctor','status','ps','uninstall','completion','projects','sources','jobs','branches')
  \$subCmds = @{
    'project'    = @('add','update','remove','list','ls')
    'source'     = @('add','update','remove','list','ls')
    'search'     = @('code','knowledge')
    'job'        = @('list','ls')
    'branch'     = @('list','ls','pin','p','unpin','u')
    'daemon'     = @('start','stop','restart','refresh','install','uninstall','status','ensure-running')
    'hook'       = @('install','uninstall')
    'completion' = @('bash','zsh','powershell')
  }

  if (\$tokens.Length -le 2) {
    \$topLevelCmds | Where-Object { \$_ -like "\${wordToComplete}*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new(\$_, \$_, 'ParameterValue', \$_)
    }
    return
  }

  \$noun = \$tokens[1]
  if (\$subCmds.ContainsKey(\$noun)) {
    \$subCmds[\$noun] | Where-Object { \$_ -like "\${wordToComplete}*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new(\$_, \$_, 'ParameterValue', \$_)
    }
  }
}
`;

export function printCompletion(shell: string): void {
  switch (shell) {
    case "bash":
      process.stdout.write(BASH_COMPLETION.trimStart());
      break;
    case "zsh":
      process.stdout.write(ZSH_COMPLETION.trimStart());
      break;
    case "powershell":
      process.stdout.write(POWERSHELL_COMPLETION.trimStart());
      break;
    default:
      console.error(`Unknown shell: ${shell}. Supported: bash, zsh, powershell`);
      process.exit(1);
  }
}
