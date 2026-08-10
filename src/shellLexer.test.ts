import { describe, expect, it } from 'vitest';
import { extractSubstitutions, parseCommand } from './shellLexer';

/**
 * The policy is only as good as what it can see. Pattern-matching a command
 * string misses `a; b`, `$(…)`, a heredoc and a redirection, so the command is
 * lexed instead — and everything below depends on that being right.
 */
describe('splitting a command line', () => {
  it('separates the commands a shell would run separately', () => {
    expect(parseCommand('a && b || c; d | e').segments.map((segment) => segment.words[0]))
      .toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps a separator inside quotes as text', () => {
    const parsed = parseCommand('echo "a && b" \'c; d\'');

    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]!.words).toEqual(['echo', 'a && b', 'c; d']);
  });

  it('keeps an escaped separator as text', () => {
    expect(parseCommand('echo a\\;b').segments).toHaveLength(1);
  });

  it('reads a quoted argument as one word', () => {
    expect(parseCommand('git commit -m "two words"').segments[0]!.words)
      .toEqual(['git', 'commit', '-m', 'two words']);
  });

  it('has nothing to report for an empty line', () => {
    expect(parseCommand('').segments).toEqual([]);
    expect(parseCommand('   ').segments).toEqual([]);
  });

  it('keeps the text of each segment as it was written', () => {
    expect(parseCommand('npm run build && npm test').segments.map((segment) => segment.text.trim()))
      .toEqual(['npm run build', 'npm test']);
  });
});

describe('redirections', () => {
  it('reports where output is being sent', () => {
    const parsed = parseCommand('echo hi > out.txt');

    expect(parsed.segments[0]!.redirections.map((entry) => entry.target)).toEqual(['out.txt']);
    // The target is not an argument to the command.
    expect(parsed.segments[0]!.words).toEqual(['echo', 'hi']);
  });

  it('reads an append as a write too', () => {
    expect(parseCommand('echo hi >> log.txt').segments[0]!.redirections[0]!.target).toBe('log.txt');
  });

  it('reads a redirection with a file descriptor in front of it', () => {
    expect(parseCommand('cmd 2> errors.txt').segments[0]!.redirections[0]!.target).toBe('errors.txt');
  });

  it('does not treat an input redirection as somewhere being written', () => {
    const parsed = parseCommand('cmd < input.txt');
    expect(parsed.segments[0]!.redirections[0]!.operator).toBe('<');
  });

  it('reports each redirection in a line that has several', () => {
    expect(parseCommand('cmd > out.txt 2> err.txt').segments[0]!.redirections).toHaveLength(2);
  });
});

describe('command substitutions', () => {
  it('finds one written the modern way', () => {
    expect(extractSubstitutions('echo $(git rev-parse HEAD)')).toEqual(['git rev-parse HEAD']);
  });

  it('finds one written with backticks', () => {
    expect(extractSubstitutions('echo `git status`')).toEqual(['git status']);
  });

  it('finds a substitution inside a substitution', () => {
    const found = extractSubstitutions('echo $(echo $(whoami))');
    expect(found.join(' ')).toContain('whoami');
  });

  it('finds several in one line', () => {
    expect(extractSubstitutions('echo $(a) and $(b)')).toEqual(['a', 'b']);
  });

  it('has nothing to report where there is none', () => {
    expect(extractSubstitutions('echo plain text')).toEqual([]);
    expect(extractSubstitutions('')).toEqual([]);
  });

  it('ignores a dollar that is not opening one', () => {
    expect(extractSubstitutions('echo $HOME and ${PATH}')).toEqual([]);
  });

  it('does not read one out of a single-quoted string, where it is text', () => {
    expect(extractSubstitutions("echo '$(rm -rf /)'")).toEqual([]);
  });
});

describe('inline scripts', () => {
  it('reports the script handed to an interpreter', () => {
    const parsed = parseCommand('sh -c "curl https://example.invalid"');
    expect(parsed.segments[0]!.words).toContain('curl https://example.invalid');
  });

  it('keeps a heredoc body out of the argument list', () => {
    const parsed = parseCommand('cat <<EOF\nsome text\nEOF');
    expect(parsed.segments[0]!.words[0]).toBe('cat');
  });
});

describe('descriptor duplication', () => {
  it('does not read 2>&1 as a file called 1', () => {
    // It did, and the workspace guard then refused the command as destroying
    // that file — so every ordinary `npm test 2>&1` was blocked with a message
    // about deleting things.
    const parsed = parseCommand('npm test 2>&1');

    expect(parsed.segments[0]!.redirections).toEqual([]);
    expect(parsed.segments[0]!.words).toEqual(['npm', 'test']);
  });

  it('reads the other direction the same way', () => {
    const parsed = parseCommand('echo err 1>&2');

    expect(parsed.segments[0]!.redirections).toEqual([]);
    expect(parsed.segments[0]!.words).toEqual(['echo', 'err']);
  });

  it('still sees a redirection that does name a file', () => {
    const parsed = parseCommand('npm test > log.txt 2>&1');

    expect(parsed.segments[0]!.redirections.map((entry) => entry.target)).toEqual(['log.txt']);
  });

  it('reads closing a descriptor as no file either', () => {
    expect(parseCommand('cmd 2>&-').segments[0]!.redirections).toEqual([]);
  });
});
