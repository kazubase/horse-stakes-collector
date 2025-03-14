import { db } from '../index.js';
import { betTypes } from '../schema.js';
const betTypesData = [
    {
        code: 'tan',
        name: '単勝',
        description: '1着になる馬を当てる',
        requiredHorses: 1,
        orderMatters: true
    },
    {
        code: 'fuku',
        name: '複勝',
        description: '3着以内に入る馬を当てる',
        requiredHorses: 1,
        orderMatters: false
    },
    {
        code: 'wakuren',
        name: '枠連',
        description: '着順を問わず、1着と2着になる枠を当てる',
        requiredHorses: 2,
        orderMatters: false
    },
    {
        code: 'umaren',
        name: '馬連',
        description: '着順を問わず、1着と2着になる馬を当てる',
        requiredHorses: 2,
        orderMatters: false
    },
    {
        code: 'wide',
        name: 'ワイド',
        description: '着順を問わず、3着以内に入る2頭を当てる',
        requiredHorses: 2,
        orderMatters: false
    },
    {
        code: 'umatan',
        name: '馬単',
        description: '1着と2着になる馬を着順通りに当てる',
        requiredHorses: 2,
        orderMatters: true
    },
    {
        code: 'sanrenpuku',
        name: '三連複',
        description: '着順を問わず、1着、2着、3着になる3頭を当てる',
        requiredHorses: 3,
        orderMatters: false
    },
    {
        code: 'sanrentan',
        name: '三連単',
        description: '1着、2着、3着になる馬を着順通りに当てる',
        requiredHorses: 3,
        orderMatters: true
    }
];
async function seedBetTypes() {
    try {
        console.log('Seeding bet types...');
        for (const betType of betTypesData) {
            await db.insert(betTypes).values(betType);
        }
        console.log('Bet types seeded successfully');
    }
    catch (error) {
        console.error('Error seeding bet types:', error);
        throw error;
    }
}
seedBetTypes();
