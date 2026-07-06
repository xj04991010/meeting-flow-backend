import { supabase } from '../utils/db';

export type ClientData = {
  name: string;
  status?: 'active' | 'paused' | 'completed';
  notes?: string;
  contact_info?: Record<string, unknown>;
  contract_start?: string;
  contract_end?: string;
  default_monthly_target?: number;
};

const CLIENT_FIELDS = [
  'name',
  'status',
  'notes',
  'contact_info',
  'contract_start',
  'contract_end',
  'default_monthly_target',
] as const;

function buildClientPayload(data: Partial<ClientData>) {
  const payload: Record<string, unknown> = {};
  for (const field of CLIENT_FIELDS) {
    const value = data[field];
    if (value !== undefined) {
      payload[field] = field === 'name' && typeof value === 'string' ? value.trim() : value;
    }
  }
  return payload;
}

export async function getClients(userId: string) {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching clients:', error);
    throw error;
  }
  return data;
}

export async function createClient(userId: string, data: ClientData) {
  const payload = buildClientPayload(data);
  if (!payload.name) throw new Error('Client name is required');

  const { data: result, error } = await supabase
    .from('clients')
    .insert([{ ...payload, user_id: userId }])
    .select()
    .single();

  if (error) {
    console.error('Error creating client:', error);
    throw error;
  }
  return result;
}

export async function updateClient(userId: string, clientId: string, data: Partial<ClientData>) {
  const payload = buildClientPayload(data);
  const { data: result, error } = await supabase
    .from('clients')
    .update(payload)
    .eq('id', clientId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    console.error('Error updating client:', error);
    throw error;
  }
  return result;
}
