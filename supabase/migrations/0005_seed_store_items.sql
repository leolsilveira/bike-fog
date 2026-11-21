-- ============================================================================
-- 0005_seed_store_items.sql
-- Catálogo inicial da loja: cosméticos permanentes e consumíveis/boosters (pt-BR).
-- ============================================================================

INSERT INTO public.store_items (
  id, kind, category, name, description, price_coins, rarity, max_stack, metadata, is_active, sort_order
)
VALUES
  -- Personagens desbloqueáveis (paridade com src/sprites/characters.ts)
  (
    'char_kenji', 'cosmetic', 'character',
    'Kenji',
    'Sabe o nome de todas as praças do bairro.',
    250, 'incomum', 1,
    '{"slot":"character","cosmeticKey":"kenji","characterId":"kenji"}'::jsonb,
    true, 10
  ),
  (
    'char_maya', 'cosmetic', 'character',
    'Maya',
    'Cabelo rosa, pace de elite, zero GPS perdido.',
    500, 'raro', 1,
    '{"slot":"character","cosmeticKey":"maya","characterId":"maya"}'::jsonb,
    true, 20
  ),
  (
    'char_zeca', 'cosmetic', 'character',
    'Zeca',
    'Lenda do pedal. Ninguém sabe quantos km ele tem.',
    900, 'epico', 1,
    '{"slot":"character","cosmeticKey":"zeca","characterId":"zeca"}'::jsonb,
    true, 30
  ),

  -- Chapéus (slot: hat)
  (
    'hat_bone_retro', 'cosmetic', 'hat',
    'Boné Retrô',
    'Aba reta clássica para correr com estilo pelas ruas.',
    80, 'comum', 1,
    '{"slot":"hat","cosmeticKey":"bone_retro","color":"#ff6b5a"}'::jsonb,
    true, 40
  ),
  (
    'hat_gorro_urbano', 'cosmetic', 'hat',
    'Gorro Urbano',
    'Perfeito para pedais e corridas na madrugada.',
    120, 'incomum', 1,
    '{"slot":"hat","cosmeticKey":"gorro_urbano","color":"#6e4bd8"}'::jsonb,
    true, 50
  ),
  (
    'hat_coroa_desbrava', 'cosmetic', 'hat',
    'Coroa do Desbravador',
    'Brilho dourado para quem domina a cidade inteira.',
    650, 'lendario', 1,
    '{"slot":"hat","cosmeticKey":"coroa_desbrava","color":"#ffd23f"}'::jsonb,
    true, 60
  ),

  -- Óculos (slot: glasses)
  (
    'glasses_aviador', 'cosmetic', 'glasses',
    'Óculos Aviador',
    'Proteção clássica contra o sol de fim de tarde.',
    90, 'comum', 1,
    '{"slot":"glasses","cosmeticKey":"aviador","color":"#2a1f3d"}'::jsonb,
    true, 70
  ),
  (
    'glasses_viseira_neon', 'cosmetic', 'glasses',
    'Viseira Neon',
    'Lente futurista com brilho menta para alta velocidade.',
    220, 'raro', 1,
    '{"slot":"glasses","cosmeticKey":"viseira_neon","color":"#4fe0b0"}'::jsonb,
    true, 80
  ),

  -- Bicicletas (slot: bike)
  (
    'bike_speed_carbon', 'cosmetic', 'bike',
    'Quadro Carbono',
    'Pintura fosca noturna para cortar o vento.',
    300, 'raro', 1,
    '{"slot":"bike","cosmeticKey":"speed_carbon","color":"#1d1a2a","shade":"#0f0d18"}'::jsonb,
    true, 90
  ),
  (
    'bike_dourada', 'cosmetic', 'bike',
    'Bike Dourada',
    'Edição especial banhada a ouro para veteranos.',
    750, 'epico', 1,
    '{"slot":"bike","cosmeticKey":"bike_dourada","color":"#ffd23f","shade":"#d19a1a"}'::jsonb,
    true, 100
  ),

  -- Tênis (slot: shoe)
  (
    'shoe_turbo_coral', 'cosmetic', 'shoe',
    'Tênis Turbo Coral',
    'Passada leve com visual vibrante.',
    110, 'incomum', 1,
    '{"slot":"shoe","cosmeticKey":"turbo_coral","color":"#ff6b5a"}'::jsonb,
    true, 110
  ),
  (
    'shoe_relampago', 'cosmetic', 'shoe',
    'Tênis Relâmpago',
    'Solado dourado para bater recordes pessoais.',
    280, 'raro', 1,
    '{"slot":"shoe","cosmeticKey":"relampago","color":"#ffd23f"}'::jsonb,
    true, 120
  ),

  -- Pets (slot: pet)
  (
    'pet_caramelo', 'cosmetic', 'pet',
    'Doguinho Caramelo',
    'O companheiro mais fiel das ruas brasileiras.',
    400, 'raro', 1,
    '{"slot":"pet","cosmeticKey":"caramelo","color":"#e09a48"}'::jsonb,
    true, 130
  ),
  (
    'pet_gatinho_pixel', 'cosmetic', 'pet',
    'Gatinho da Névoa',
    'Mascote místico que acompanha cada passo no mapa.',
    450, 'epico', 1,
    '{"slot":"pet","cosmeticKey":"gatinho_pixel","color":"#b77bff"}'::jsonb,
    true, 140
  ),

  -- Paletas de cores exclusivas (slot: color)
  (
    'color_neon_cyber', 'cosmetic', 'color',
    'Paleta Cyber Neon',
    'Combinação exclusiva menta, rosa e azul celeste.',
    150, 'incomum', 1,
    '{"slot":"color","cosmeticKey":"neon_cyber","colors":{"top":"#4fe0b0","helmet":"#ff7ab8","bike":"#5ab8f0"}}'::jsonb,
    true, 150
  ),
  (
    'color_aurora_real', 'cosmetic', 'color',
    'Paleta Aurora Real',
    'Tons reais de violeta, ouro e rosa vibrante.',
    320, 'raro', 1,
    '{"slot":"color","cosmeticKey":"aurora_real","colors":{"top":"#6e4bd8","helmet":"#ffd23f","bike":"#ff6b9a"}}'::jsonb,
    true, 160
  ),

  -- Consumíveis / Boosters (empilháveis até 10 unidades)
  (
    'boost_xp_2x', 'consumable', 'boost_xp',
    'Dobro de XP (30 min)',
    'Multiplica por 2x todo o XP ganho durante 30 minutos de atividade.',
    60, 'incomum', 10,
    '{"effect":"xp_multiplier","multiplier":2,"durationMin":30,"duration_s":1800}'::jsonb,
    true, 200
  ),
  (
    'boost_fog_wide', 'consumable', 'boost_fog',
    'Radar de Névoa +50% (30 min)',
    'Amplia o raio de revelação da névoa em 50% por 30 minutos.',
    75, 'raro', 10,
    '{"effect":"fog_radius_multiplier","multiplier":1.5,"durationMin":30,"duration_s":1800}'::jsonb,
    true, 210
  ),
  (
    'boost_coins_2x', 'consumable', 'boost_coins',
    'Imã de Moedas 2x (30 min)',
    'Dobra o valor das moedas coletadas na rua por 30 minutos.',
    85, 'raro', 10,
    '{"effect":"coins_multiplier","multiplier":2,"durationMin":30,"duration_s":1800}'::jsonb,
    true, 220
  )
ON CONFLICT (id) DO UPDATE
  SET kind = EXCLUDED.kind,
      category = EXCLUDED.category,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      price_coins = EXCLUDED.price_coins,
      rarity = EXCLUDED.rarity,
      max_stack = EXCLUDED.max_stack,
      metadata = EXCLUDED.metadata,
      is_active = EXCLUDED.is_active,
      sort_order = EXCLUDED.sort_order;
