import { supabase } from '../utils/db';

export interface PlaybookRule {
  id: string;
  domain: string;
  trigger_pattern: string;
  action_type: string;
  rule_text: string;
  weight: number;
}

export async function loadPlaybookRules(userId: string): Promise<PlaybookRule[]> {
  try {
    const { data, error } = await supabase
      .from('playbook_rules')
      .select('*')
      .eq('user_id', userId)
      .eq('enabled', true)
      .order('weight', { ascending: false });

    if (error) {
      console.error('Error loading playbook rules:', error);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error('Exception loading playbook rules:', err);
    return [];
  }
}

export function buildPlaybookPrompt(rules: PlaybookRule[]): string {
  if (!rules || rules.length === 0) return '';
  
  let prompt = '## PLAYBOOK RULES (Strictly enforce these based on trigger patterns):\n';
  rules.forEach((rule, idx) => {
    prompt += `${idx + 1}. [IF MATCHES: ${rule.trigger_pattern}] -> ${rule.rule_text} (Weight: ${rule.weight})\n`;
  });
  
  return prompt;
}

export async function updateRuleWeight(ruleId: string, delta: number): Promise<void> {
  try {
    const { data: rule } = await supabase.from('playbook_rules').select('weight').eq('id', ruleId).single();
    if (rule) {
      const newWeight = Math.max(0.1, Number(rule.weight) + delta);
      await supabase.from('playbook_rules').update({ weight: newWeight }).eq('id', ruleId);
    }
  } catch (err) {
    console.error('Error updating rule weight:', err);
  }
}
