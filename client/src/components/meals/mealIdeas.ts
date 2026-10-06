import type { MealType } from './weeklyPlan';

export type MealIdea = {
  id: string;
  name: string;
  type: MealType;
  description: string;
  ingredients: readonly { name: string; unit: string; quantity: number }[];
};

// Local starting recipes. Amounts are editable shopping estimates per person;
// these ideas do not seed the catalog or certify a complete childcare menu.
export const MEAL_IDEAS: readonly MealIdea[] = [
  { id: 'banana-oatmeal', name: 'Oatmeal with banana', type: 'breakfast', description: 'Oats with banana and milk.',
    ingredients: [{ name: 'Oats', unit: 'g', quantity: 30 }, { name: 'Banana', unit: 'g', quantity: 60 }, { name: 'Milk', unit: 'ml', quantity: 120 }] },
  { id: 'eggs-toast', name: 'Eggs and toast', type: 'breakfast', description: 'Eggs with whole wheat toast.',
    ingredients: [{ name: 'Eggs', unit: 'count', quantity: 1 }, { name: 'Whole wheat bread', unit: 'g', quantity: 30 }, { name: 'Butter', unit: 'g', quantity: 3 }] },
  { id: 'apple-yogurt', name: 'Yogurt with apples', type: 'breakfast', description: 'Plain yogurt, apple and oats.',
    ingredients: [{ name: 'Plain yogurt', unit: 'g', quantity: 100 }, { name: 'Apple', unit: 'g', quantity: 60 }, { name: 'Oats', unit: 'g', quantity: 15 }] },
  { id: 'banana-pancakes', name: 'Banana pancakes', type: 'breakfast', description: 'Pancakes made with banana, oats and egg.',
    ingredients: [{ name: 'Banana', unit: 'g', quantity: 60 }, { name: 'Oats', unit: 'g', quantity: 25 }, { name: 'Eggs', unit: 'count', quantity: 0.5 }, { name: 'Milk', unit: 'ml', quantity: 30 }] },
  { id: 'cheese-omelet', name: 'Cheese omelet', type: 'breakfast', description: 'Eggs with cheese and spinach.',
    ingredients: [{ name: 'Eggs', unit: 'count', quantity: 1 }, { name: 'Cheese', unit: 'g', quantity: 15 }, { name: 'Spinach', unit: 'g', quantity: 15 }, { name: 'Olive oil', unit: 'ml', quantity: 3 }] },
  { id: 'apple-cheese', name: 'Apple and cheese', type: 'snack', description: 'Apple with cheese.',
    ingredients: [{ name: 'Apple', unit: 'g', quantity: 80 }, { name: 'Cheese', unit: 'g', quantity: 20 }] },
  { id: 'banana-yogurt', name: 'Banana and yogurt', type: 'snack', description: 'Banana with plain yogurt.',
    ingredients: [{ name: 'Banana', unit: 'g', quantity: 60 }, { name: 'Plain yogurt', unit: 'g', quantity: 80 }] },
  { id: 'berries-toast', name: 'Berries and toast', type: 'snack', description: 'Berries with whole wheat toast.',
    ingredients: [{ name: 'Berries', unit: 'g', quantity: 60 }, { name: 'Whole wheat bread', unit: 'g', quantity: 30 }] },
  { id: 'pear-cottage-cheese', name: 'Pear and cottage cheese', type: 'snack', description: 'Pear with cottage cheese.',
    ingredients: [{ name: 'Pear', unit: 'g', quantity: 80 }, { name: 'Cottage cheese', unit: 'g', quantity: 60 }] },
  { id: 'avocado-toast', name: 'Avocado toast', type: 'snack', description: 'Avocado on whole wheat bread.',
    ingredients: [{ name: 'Avocado', unit: 'g', quantity: 40 }, { name: 'Whole wheat bread', unit: 'g', quantity: 30 }] },
  { id: 'chicken-rice', name: 'Chicken and rice', type: 'lunch', description: 'Chicken with rice, carrots and peas.',
    ingredients: [{ name: 'Chicken', unit: 'g', quantity: 60 }, { name: 'Rice', unit: 'g', quantity: 30 }, { name: 'Carrots', unit: 'g', quantity: 40 }, { name: 'Peas', unit: 'g', quantity: 30 }] },
  { id: 'vegetable-pasta', name: 'Vegetable pasta', type: 'lunch', description: 'Pasta with tomato, zucchini and cheese.',
    ingredients: [{ name: 'Pasta', unit: 'g', quantity: 40 }, { name: 'Tomato', unit: 'g', quantity: 60 }, { name: 'Zucchini', unit: 'g', quantity: 40 }, { name: 'Cheese', unit: 'g', quantity: 15 }] },
  { id: 'lentil-soup', name: 'Lentil soup', type: 'lunch', description: 'Lentils, carrots, onion and tomato.',
    ingredients: [{ name: 'Lentils', unit: 'g', quantity: 30 }, { name: 'Carrots', unit: 'g', quantity: 40 }, { name: 'Onion', unit: 'g', quantity: 15 }, { name: 'Tomato', unit: 'g', quantity: 40 }] },
  { id: 'turkey-meatballs', name: 'Turkey meatballs with pasta', type: 'lunch', description: 'Turkey meatballs, pasta and tomato sauce.',
    ingredients: [{ name: 'Ground turkey', unit: 'g', quantity: 60 }, { name: 'Pasta', unit: 'g', quantity: 35 }, { name: 'Tomato', unit: 'g', quantity: 60 }, { name: 'Breadcrumbs', unit: 'g', quantity: 10 }] },
  { id: 'bean-quesadilla', name: 'Bean and cheese quesadilla', type: 'lunch', description: 'Tortilla with beans, cheese and tomato.',
    ingredients: [{ name: 'Tortilla', unit: 'g', quantity: 40 }, { name: 'Beans', unit: 'g', quantity: 60 }, { name: 'Cheese', unit: 'g', quantity: 20 }, { name: 'Tomato', unit: 'g', quantity: 30 }] },
  { id: 'chicken-soup', name: 'Chicken vegetable soup', type: 'lunch', description: 'Chicken, potato, carrots and onion.',
    ingredients: [{ name: 'Chicken', unit: 'g', quantity: 50 }, { name: 'Potato', unit: 'g', quantity: 60 }, { name: 'Carrots', unit: 'g', quantity: 40 }, { name: 'Onion', unit: 'g', quantity: 15 }] },
  { id: 'rice-beans', name: 'Rice and beans', type: 'lunch', description: 'Rice with beans, tomato and bell pepper.',
    ingredients: [{ name: 'Rice', unit: 'g', quantity: 30 }, { name: 'Beans', unit: 'g', quantity: 60 }, { name: 'Tomato', unit: 'g', quantity: 40 }, { name: 'Bell pepper', unit: 'g', quantity: 30 }] },
  { id: 'cheese-toast', name: 'Cheese toast', type: 'afternoonSnack', description: 'Whole wheat bread with cheese.',
    ingredients: [{ name: 'Whole wheat bread', unit: 'g', quantity: 30 }, { name: 'Cheese', unit: 'g', quantity: 20 }] },
  { id: 'fruit-yogurt', name: 'Fruit and yogurt bowl', type: 'afternoonSnack', description: 'Plain yogurt with banana and berries.',
    ingredients: [{ name: 'Plain yogurt', unit: 'g', quantity: 100 }, { name: 'Banana', unit: 'g', quantity: 40 }, { name: 'Berries', unit: 'g', quantity: 40 }] },
  { id: 'hummus-pita', name: 'Hummus and pita', type: 'afternoonSnack', description: 'Pita with hummus.',
    ingredients: [{ name: 'Hummus', unit: 'g', quantity: 40 }, { name: 'Pita bread', unit: 'g', quantity: 30 }] },
];
