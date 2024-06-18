import { Sequelize, DataTypes, Op } from 'sequelize';

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: 'database.sqlite',
  logging: false
});

const User = sequelize.define('User', {
  userId: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false,
  }
});

const Reminder = sequelize.define('Reminder', {
  userId: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  remindAt: {
    type: DataTypes.DATE,
    allowNull: false,
  }
});

const initialize = async () => {
  await sequelize.sync();
};

export default {
  User,
  Reminder,
  initialize
};
