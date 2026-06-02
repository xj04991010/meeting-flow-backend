import { supabase } from '../utils/db';

export async function loadRelevantMemories(userId: string, inputText: string): Promise<any[]> {
  try {
    // For now, load active memories ordered by importance and used_count
    // In the future, this can be improved with pgvector similarity search
    const { data } = await supabase
      .from('memories')
      .select('id, user_id, type, entity_type, content, importance, used_count')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('importance', { ascending: false })
      .order('used_count', { ascending: false })
      .limit(10);
      
    return data || [];
  } catch (err) {
    console.error('Error loading relevant memories:', err);
    return [];
  }
}

export async function reinforceMemory(memoryId: string): Promise<void> {
  try {
    // Increment used_count, accepted_count and bump importance up to 1.0
    await supabase.rpc('reinforce_memory', { target_memory_id: memoryId });
    // If rpc doesn't exist, we can fallback to raw update via postgres logic or fetch then update
    
    // Fallback logic
    const { data } = await supabase.from('memories').select('importance, used_count, accepted_count').eq('id', memoryId).single();
    if (data) {
      await supabase.from('memories').update({
        importance: Math.min(1.0, Number(data.importance) + 0.1),
        used_count: (data.used_count || 0) + 1,
        accepted_count: (data.accepted_count || 0) + 1,
        confidence: 0.9
      }).eq('id', memoryId);
    }
  } catch (err) {
    console.error('Error reinforcing memory:', err);
  }
}

export async function penalizeMemory(memoryId: string): Promise<void> {
  try {
    // Decrement confidence, increase rejected_count
    const { data } = await supabase.from('memories').select('confidence, rejected_count').eq('id', memoryId).single();
    if (data) {
      await supabase.from('memories').update({
        confidence: Math.max(0, Number(data.confidence || 0.5) - 0.2),
        rejected_count: (data.rejected_count || 0) + 1
      }).eq('id', memoryId);
    }
  } catch (err) {
    console.error('Error penalizing memory:', err);
  }
}

export async function decayUnusedMemories(): Promise<void> {
  // Can be called by cron job weekly to decay memory importance
  try {
    const { data } = await supabase.from('memories').select('id, importance').eq('is_active', true);
    if (!data) return;
    
    for (const mem of data) {
      const newImp = Math.max(0.1, Number(mem.importance) * 0.95);
      await supabase.from('memories').update({ importance: newImp }).eq('id', mem.id);
    }
  } catch (err) {
    console.error('Error decaying memories:', err);
  }
}
